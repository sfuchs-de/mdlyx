use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

const KEYCHAIN_SERVICE: &str = "org.mdlyx.app";
const KEYCHAIN_ACCOUNT: &str = "github-library-session";
const MAX_LIBRARY_DEPTH: usize = 8;
const INDEX_HEAD_BYTES: usize = 65_536;
const MAX_RETAINED_INDEX_FIELD_BYTES: usize = 8 * 1024 * 1024;
const MAX_LIBRARY_ASSET_BYTES: usize = 25 * 1024 * 1024;
const NATIVE_FILE_IDENTITIES_NAME: &str = "native-file-identities.json";
const NATIVE_FILE_IDENTITIES_VERSION: u8 = 1;
const MAX_TEXT_PREFIX_CHARS: usize = 1_000_001;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeLibraryEntry {
    name: String,
    folder: String,
    path: String,
    meta: Value,
    open_comment_count: usize,
}

#[derive(Serialize)]
struct NativeOpenedFile {
    name: String,
    path: String,
    text: String,
}

#[derive(Default)]
struct NativeGrants {
    files: Mutex<HashMap<String, PathBuf>>,
    roots: Mutex<HashMap<String, PathBuf>>,
    file_identities: Mutex<NativeFileIdentityStore>,
}

#[derive(Default)]
struct NativeFileIdentityStore {
    path: Option<PathBuf>,
    files: HashMap<String, PathBuf>,
    roots: HashMap<String, PathBuf>,
}

#[derive(Serialize, Deserialize)]
struct NativeFileIdentityData {
    version: u8,
    files: BTreeMap<String, String>,
    #[serde(default)]
    roots: BTreeMap<String, String>,
}

#[derive(Default)]
struct LoadedNativeIdentities {
    files: HashMap<String, PathBuf>,
    roots: HashMap<String, PathBuf>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeFileGrant {
    grant_id: String,
    identity: String,
    name: String,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeRootGrant {
    grant_id: String,
    identity: String,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GrantedLibraryEntry {
    name: String,
    folder: String,
    grant_id: String,
    identity: String,
    meta: Value,
    open_comment_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeAssetEntry {
    path: String,
    size: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bytes: Option<Vec<u8>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AtomicWritePrivacy {
    PreserveTarget,
    Private,
}

fn open_atomic_temporary(
    target: &Path,
    temporary: &Path,
    privacy: AtomicWritePrivacy,
) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    // `mode` is applied by open(2), so a private identity-store temp is never
    // briefly created using the process umask before its canonical paths are
    // written. The explicit chmod below is defense in depth.
    #[cfg(unix)]
    if privacy == AtomicWritePrivacy::Private {
        options.mode(0o600);
    }
    let file = options.open(temporary).map_err(|error| error.to_string())?;
    match privacy {
        AtomicWritePrivacy::PreserveTarget => {
            if let Ok(metadata) = fs::metadata(target) {
                fs::set_permissions(temporary, metadata.permissions())
                    .map_err(|error| error.to_string())?;
            }
        }
        AtomicWritePrivacy::Private => {
            #[cfg(unix)]
            fs::set_permissions(temporary, fs::Permissions::from_mode(0o600))
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(file)
}

// Atomic write: write to a sibling temp file then rename over the target, so a
// crash (or autosave firing mid-write) can never leave the user's document
// truncated or half-written. Rename is atomic on the same filesystem.
fn atomic_write_with_privacy(
    path: &Path,
    contents: &[u8],
    privacy: AtomicWritePrivacy,
) -> Result<(), String> {
    let parent = path.parent().ok_or("Document path has no parent folder")?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("Document filename is invalid")?;
    cleanup_abandoned_temps(parent, name);
    let temporary = parent.join(format!(".{name}.mathdown-{}.tmp", Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let mut file = open_atomic_temporary(path, &temporary, privacy)?;
        file.write_all(contents)
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        fs::rename(&temporary, path).map_err(|error| error.to_string())?;
        // Persist the directory entry where supported. A failure here is
        // reported even though the complete new file already exists.
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| error.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), String> {
    atomic_write_with_privacy(path, contents, AtomicWritePrivacy::PreserveTarget)
}

fn atomic_write_private(path: &Path, contents: &[u8]) -> Result<(), String> {
    atomic_write_with_privacy(path, contents, AtomicWritePrivacy::Private)
}

fn cleanup_abandoned_temps(parent: &Path, name: &str) {
    let prefix = format!(".{name}.mathdown-");
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let candidate = entry.file_name().to_string_lossy().into_owned();
        if !candidate.starts_with(&prefix) || !candidate.ends_with(".tmp") {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .is_some_and(|age| age >= Duration::from_secs(24 * 60 * 60));
        if stale {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn valid_native_identity(identity: &str) -> bool {
    Uuid::parse_str(identity).is_ok_and(|value| value.get_version_num() == 4)
}

fn canonical_markdown_file(path: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("Markdown documents cannot be symbolic links".into());
    }
    let canonical = path.canonicalize().map_err(|error| error.to_string())?;
    if !canonical.is_file()
        || !canonical.is_absolute()
        || !markdown_name(canonical.to_string_lossy().as_ref())
    {
        return Err("Choose a Markdown document".into());
    }
    Ok(canonical)
}

fn load_file_identity_data(path: &Path) -> Result<LoadedNativeIdentities, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(LoadedNativeIdentities::default());
        }
        Err(error) => return Err(error.to_string()),
    };
    let data = match serde_json::from_slice::<NativeFileIdentityData>(&bytes) {
        Ok(data) if data.version == NATIVE_FILE_IDENTITIES_VERSION => data,
        Ok(_) => {
            eprintln!("MdLyx ignored an unsupported native file identity store");
            return Ok(LoadedNativeIdentities::default());
        }
        Err(_) => {
            eprintln!("MdLyx ignored an invalid native file identity store");
            return Ok(LoadedNativeIdentities::default());
        }
    };

    let mut files = HashMap::new();
    let mut seen_paths = HashMap::<PathBuf, String>::new();
    for (identity, raw_path) in data.files {
        let path = PathBuf::from(raw_path);
        if !valid_native_identity(&identity)
            || !path.is_absolute()
            || !markdown_name(path.to_string_lossy().as_ref())
            || seen_paths.contains_key(&path)
        {
            continue;
        }
        seen_paths.insert(path.clone(), identity.clone());
        files.insert(identity, path);
    }
    let mut roots = HashMap::new();
    let mut seen_roots = HashMap::<PathBuf, String>::new();
    for (identity, raw_path) in data.roots {
        let path = PathBuf::from(raw_path);
        if !valid_native_identity(&identity)
            || !path.is_absolute()
            || seen_roots.contains_key(&path)
        {
            continue;
        }
        seen_roots.insert(path.clone(), identity.clone());
        roots.insert(identity, path);
    }
    Ok(LoadedNativeIdentities { files, roots })
}

fn configure_file_identity_store(grants: &NativeGrants, path: PathBuf) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or("Native file identity store has no parent folder")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err("Native file identity storage cannot be a symbolic link".into());
        }
        Ok(metadata) if !metadata.is_file() => {
            return Err("Native file identity storage must be a regular file".into());
        }
        #[cfg(unix)]
        Ok(_) => fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?,
        #[cfg(not(unix))]
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    let loaded = load_file_identity_data(&path)?;
    let mut store = grants
        .file_identities
        .lock()
        .map_err(|_| "Native file identities are unavailable")?;
    store.path = Some(path);
    store.files = loaded.files;
    store.roots = loaded.roots;
    Ok(())
}

fn persist_file_identity_store(store: &NativeFileIdentityStore) -> Result<(), String> {
    let path = store
        .path
        .as_ref()
        .ok_or("Native file identity storage is not configured")?;
    let mut files = BTreeMap::new();
    for (identity, file_path) in &store.files {
        let raw_path = file_path
            .to_str()
            .ok_or("Native file paths must be valid UTF-8")?;
        files.insert(identity.clone(), raw_path.to_owned());
    }
    let mut roots = BTreeMap::new();
    for (identity, root_path) in &store.roots {
        let raw_path = root_path
            .to_str()
            .ok_or("Native library paths must be valid UTF-8")?;
        roots.insert(identity.clone(), raw_path.to_owned());
    }
    let bytes = serde_json::to_vec(&NativeFileIdentityData {
        version: NATIVE_FILE_IDENTITIES_VERSION,
        files,
        roots,
    })
    .map_err(|error| error.to_string())?;
    atomic_write_private(path, &bytes)?;
    #[cfg(unix)]
    {
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
        File::open(path)
            .and_then(|file| file.sync_all())
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn file_identities_for_paths(
    grants: &NativeGrants,
    paths: &[PathBuf],
) -> Result<HashMap<PathBuf, String>, String> {
    let mut store = grants
        .file_identities
        .lock()
        .map_err(|_| "Native file identities are unavailable")?;
    if store.path.is_none() {
        return Err("Native file identity storage is not configured".into());
    }
    let mut identities = store
        .files
        .iter()
        .map(|(identity, path)| (path.clone(), identity.clone()))
        .collect::<HashMap<_, _>>();
    let mut added = Vec::new();
    for raw_path in paths {
        let path = canonical_markdown_file(raw_path)?;
        if identities.contains_key(&path) {
            continue;
        }
        let identity = Uuid::new_v4().to_string();
        store.files.insert(identity.clone(), path.clone());
        identities.insert(path.clone(), identity.clone());
        added.push((identity, path));
    }
    if !added.is_empty() {
        if let Err(error) = persist_file_identity_store(&store) {
            for (identity, path) in added {
                store.files.remove(&identity);
                identities.remove(&path);
            }
            return Err(error);
        }
    }
    Ok(identities)
}

fn add_file_grant_with_identity(
    grants: &NativeGrants,
    path: PathBuf,
) -> Result<(String, String), String> {
    let canonical = canonical_markdown_file(&path)?;
    let identities = file_identities_for_paths(grants, std::slice::from_ref(&canonical))?;
    let identity = identities
        .get(&canonical)
        .cloned()
        .ok_or("Native file identity could not be created")?;
    Ok((add_file_grant(grants, canonical)?, identity))
}

fn issue_file_grant(grants: &NativeGrants, path: PathBuf) -> Result<String, String> {
    let grant_id = Uuid::new_v4().to_string();
    grants
        .files
        .lock()
        .map_err(|_| "Native file grants are unavailable")?
        .insert(grant_id.clone(), path);
    Ok(grant_id)
}

fn reconnect_file_by_identity(
    grants: &NativeGrants,
    identity: &str,
) -> Result<Option<NativeFileGrant>, String> {
    if !valid_native_identity(identity) {
        return Ok(None);
    }
    let stored_path = grants
        .file_identities
        .lock()
        .map_err(|_| "Native file identities are unavailable")?
        .files
        .get(identity)
        .cloned();
    let Some(stored_path) = stored_path else {
        return Ok(None);
    };
    if !stored_path.exists() {
        return Ok(None);
    }
    let canonical = canonical_markdown_file(&stored_path)?;
    if canonical != stored_path {
        return Err("The remembered document path no longer identifies the original file".into());
    }
    let text = fs::read_to_string(&canonical).map_err(|error| error.to_string())?;
    let name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("untitled.md")
        .to_string();
    Ok(Some(NativeFileGrant {
        grant_id: issue_file_grant(grants, canonical)?,
        identity: identity.to_owned(),
        name,
        text,
    }))
}

fn add_file_grant(grants: &NativeGrants, path: PathBuf) -> Result<String, String> {
    let mut files = grants
        .files
        .lock()
        .map_err(|_| "Native file grants are unavailable")?;
    if let Some((grant_id, _)) = files.iter().find(|(_, granted)| **granted == path) {
        return Ok(grant_id.clone());
    }
    let grant_id = Uuid::new_v4().to_string();
    files.insert(grant_id.clone(), path);
    Ok(grant_id)
}

fn canonical_native_root(path: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("Library folders cannot be symbolic links".into());
    }
    let canonical = path.canonicalize().map_err(|error| error.to_string())?;
    if !canonical.is_absolute() || !canonical.is_dir() {
        return Err("Choose a library folder".into());
    }
    Ok(canonical)
}

fn root_identity_for_path(grants: &NativeGrants, path: &Path) -> Result<String, String> {
    let canonical = canonical_native_root(path)?;
    let mut store = grants
        .file_identities
        .lock()
        .map_err(|_| "Native file identities are unavailable")?;
    if store.path.is_none() {
        return Err("Native file identity storage is not configured".into());
    }
    if let Some((identity, _)) = store
        .roots
        .iter()
        .find(|(_, remembered)| **remembered == canonical)
    {
        return Ok(identity.clone());
    }
    let identity = Uuid::new_v4().to_string();
    store.roots.insert(identity.clone(), canonical);
    if let Err(error) = persist_file_identity_store(&store) {
        store.roots.remove(&identity);
        return Err(error);
    }
    Ok(identity)
}

fn add_root_grant_with_identity(
    grants: &NativeGrants,
    path: PathBuf,
) -> Result<(String, String), String> {
    let canonical = canonical_native_root(&path)?;
    let identity = root_identity_for_path(grants, &canonical)?;
    Ok((add_root_grant(grants, canonical)?, identity))
}

fn reconnect_root_by_identity(
    grants: &NativeGrants,
    identity: &str,
) -> Result<Option<NativeRootGrant>, String> {
    if !valid_native_identity(identity) {
        return Ok(None);
    }
    let stored_path = grants
        .file_identities
        .lock()
        .map_err(|_| "Native file identities are unavailable")?
        .roots
        .get(identity)
        .cloned();
    let Some(stored_path) = stored_path else {
        return Ok(None);
    };
    if !stored_path.exists() {
        return Ok(None);
    }
    let canonical = canonical_native_root(&stored_path)?;
    if canonical != stored_path {
        return Err("The remembered library path no longer identifies the original folder".into());
    }
    let name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Library")
        .to_string();
    Ok(Some(NativeRootGrant {
        grant_id: add_root_grant(grants, canonical)?,
        identity: identity.to_owned(),
        name,
    }))
}

fn add_root_grant(grants: &NativeGrants, path: PathBuf) -> Result<String, String> {
    let grant_id = Uuid::new_v4().to_string();
    grants
        .roots
        .lock()
        .map_err(|_| "Native library grants are unavailable")?
        .insert(grant_id.clone(), path);
    Ok(grant_id)
}

fn granted_file(grants: &NativeGrants, grant_id: &str) -> Result<PathBuf, String> {
    grants
        .files
        .lock()
        .map_err(|_| "Native file grants are unavailable")?
        .get(grant_id)
        .cloned()
        .ok_or_else(|| "This file grant is no longer available; choose the file again".into())
}

fn granted_root(grants: &NativeGrants, grant_id: &str) -> Result<PathBuf, String> {
    grants
        .roots
        .lock()
        .map_err(|_| "Native library grants are unavailable")?
        .get(grant_id)
        .cloned()
        .ok_or_else(|| "This library grant is no longer available; choose the folder again".into())
}

fn validated_granted_file(grants: &NativeGrants, grant_id: &str) -> Result<PathBuf, String> {
    let granted = granted_file(grants, grant_id)?;
    let canonical = canonical_markdown_file(&granted)?;
    if canonical != granted {
        return Err("The granted document path changed; choose the file again".into());
    }
    Ok(canonical)
}

fn validated_granted_root(grants: &NativeGrants, grant_id: &str) -> Result<PathBuf, String> {
    let granted = granted_root(grants, grant_id)?;
    let canonical = canonical_native_root(&granted)?;
    if canonical != granted {
        return Err("The granted library path changed; choose the folder again".into());
    }
    Ok(canonical)
}

#[tauri::command]
async fn native_pick_file(
    app: tauri::AppHandle,
    grants: tauri::State<'_, NativeGrants>,
) -> Result<Option<NativeFileGrant>, String> {
    let selected = app
        .dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown"])
        .blocking_pick_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected.into_path().map_err(|error| error.to_string())?;
    let canonical = canonical_markdown_file(&path)?;
    let text = fs::read_to_string(&canonical).map_err(|error| error.to_string())?;
    let name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("untitled.md")
        .to_string();
    let (grant_id, identity) = add_file_grant_with_identity(&grants, canonical)?;
    Ok(Some(NativeFileGrant {
        grant_id,
        identity,
        name,
        text,
    }))
}

#[tauri::command]
async fn native_save_file(
    app: tauri::AppHandle,
    grants: tauri::State<'_, NativeGrants>,
    suggested_name: String,
    contents: String,
) -> Result<Option<NativeFileGrant>, String> {
    let selected = app
        .dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown"])
        .set_file_name(suggested_name)
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected.into_path().map_err(|error| error.to_string())?;
    if !markdown_name(path.to_string_lossy().as_ref()) {
        return Err("Save the document with a .md or .markdown extension".into());
    }
    atomic_write(&path, contents.as_bytes())?;
    let canonical = canonical_markdown_file(&path)?;
    let name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("untitled.md")
        .to_string();
    let (grant_id, identity) = add_file_grant_with_identity(&grants, canonical)?;
    Ok(Some(NativeFileGrant {
        grant_id,
        identity,
        name,
        text: contents,
    }))
}

#[tauri::command]
fn native_reconnect_file(
    grants: tauri::State<'_, NativeGrants>,
    identity: String,
) -> Result<Option<NativeFileGrant>, String> {
    reconnect_file_by_identity(&grants, &identity)
}

#[tauri::command]
fn native_read_file(
    grants: tauri::State<'_, NativeGrants>,
    grant_id: String,
) -> Result<String, String> {
    fs::read_to_string(validated_granted_file(&grants, &grant_id)?)
        .map_err(|error| error.to_string())
}

fn read_text_prefix(path: &Path, max_chars: usize) -> Result<String, String> {
    if max_chars == 0 || max_chars > MAX_TEXT_PREFIX_CHARS {
        return Err("Text prefix length is outside the supported range".into());
    }
    // Four UTF-8 bytes cover every Unicode scalar. This bounds both the file
    // read and the WebView bridge before truncating to JavaScript-compatible
    // UTF-16 code units below.
    let max_bytes = max_chars
        .checked_mul(4)
        .ok_or("Text prefix length is outside the supported range")?;
    let mut bytes = Vec::with_capacity(max_bytes.min(64 * 1024));
    File::open(path)
        .map_err(|error| error.to_string())?
        .take(max_bytes as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let valid_bytes = match std::str::from_utf8(&bytes) {
        Ok(_) => bytes.len(),
        Err(error) if error.error_len().is_none() => error.valid_up_to(),
        Err(error) => return Err(error.to_string()),
    };
    let source = std::str::from_utf8(&bytes[..valid_bytes]).map_err(|error| error.to_string())?;
    let mut output = String::new();
    let mut utf16_units = 0;
    for character in source.chars() {
        let next = character.len_utf16();
        if utf16_units + next > max_chars {
            break;
        }
        output.push(character);
        utf16_units += next;
    }
    Ok(output)
}

#[tauri::command]
fn native_read_file_prefix(
    grants: tauri::State<'_, NativeGrants>,
    grant_id: String,
    max_chars: usize,
) -> Result<String, String> {
    let path = validated_granted_file(&grants, &grant_id)?;
    read_text_prefix(&path, max_chars)
}

#[tauri::command]
fn native_write_file(
    grants: tauri::State<'_, NativeGrants>,
    grant_id: String,
    contents: String,
) -> Result<(), String> {
    let path = validated_granted_file(&grants, &grant_id)?;
    atomic_write(&path, contents.as_bytes())
}

#[tauri::command]
fn native_close_file(
    grants: tauri::State<'_, NativeGrants>,
    grant_id: String,
) -> Result<(), String> {
    grants
        .files
        .lock()
        .map_err(|_| "Native file grants are unavailable")?
        .remove(&grant_id);
    Ok(())
}

fn markdown_name(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| {
            value.eq_ignore_ascii_case("md") || value.eq_ignore_ascii_case("markdown")
        })
}

fn library_relative_path(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.contains('\\') {
        return Err("Library paths must use forward slashes".into());
    }
    let mut path = PathBuf::new();
    let mut count = 0;
    for component in Path::new(&trimmed).components() {
        let Component::Normal(value) = component else {
            return Err("Library path must stay inside the selected folder".into());
        };
        let value = value.to_string_lossy();
        if value.starts_with('.') || value.is_empty() {
            return Err("Hidden and empty library paths are not allowed".into());
        }
        path.push(value.as_ref());
        count += 1;
    }
    if count == 0 || count > MAX_LIBRARY_DEPTH + 1 {
        return Err("Library path has an invalid depth".into());
    }
    if !markdown_name(
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default(),
    ) {
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or("Library path has an invalid filename")?;
        path.set_file_name(format!("{name}.md"));
    }
    Ok(path)
}

fn asset_name(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "bib"
                    | "png"
                    | "jpg"
                    | "jpeg"
                    | "gif"
                    | "webp"
                    | "svg"
                    | "pdf"
                    | "tex"
                    | "sty"
                    | "cls"
                    | "bst"
            )
        })
}

fn asset_relative_path(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim().replace('\\', "/");
    let mut path = PathBuf::new();
    let mut count = 0;
    for component in Path::new(&trimmed).components() {
        let Component::Normal(value) = component else {
            return Err("Asset path must stay inside the selected folder".into());
        };
        let value = value.to_string_lossy();
        if value.starts_with('.') || value.is_empty() {
            return Err("Hidden and empty asset paths are not allowed".into());
        }
        path.push(value.as_ref());
        count += 1;
    }
    if count == 0 || count > MAX_LIBRARY_DEPTH + 1 || !asset_name(path.to_string_lossy().as_ref()) {
        return Err("Asset path has an unsupported type or invalid depth".into());
    }
    Ok(path)
}

fn content_sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[derive(Clone, Copy)]
enum IndexField {
    Library,
    Comments,
}

struct NativeIndex {
    meta: Value,
    open_comment_count: usize,
}

fn empty_meta_value() -> Value {
    let mut meta = Map::new();
    for key in ["tags", "contains", "projects", "related"] {
        meta.insert(key.into(), Value::Array(Vec::new()));
    }
    Value::Object(meta)
}

impl Default for NativeIndex {
    fn default() -> Self {
        Self {
            meta: empty_meta_value(),
            open_comment_count: 0,
        }
    }
}

fn clean_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn clean_string_array(value: Option<&Value>) -> Value {
    Value::Array(
        value
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| item.as_str())
            .take(200)
            .map(|item| Value::String(item.to_owned()))
            .collect(),
    )
}

fn compact_library_meta(value: &Value) -> Option<Value> {
    let source = value.as_object()?;
    let mut result = Map::new();
    for key in ["id", "title", "kind", "status", "visibility"] {
        if let Some(value) = clean_string(source.get(key)) {
            result.insert(key.into(), Value::String(value));
        }
    }
    for key in ["tags", "contains", "projects"] {
        result.insert(key.into(), clean_string_array(source.get(key)));
    }
    let related = source
        .get("related")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let item = item.as_object()?;
            let id = clean_string(item.get("id"))?;
            let relation = clean_string(item.get("rel"))?;
            let mut result = Map::new();
            result.insert("id".into(), Value::String(id));
            result.insert("rel".into(), Value::String(relation));
            Some(Value::Object(result))
        })
        .take(200)
        .collect();
    result.insert("related".into(), Value::Array(related));
    Some(Value::Object(result))
}

fn unresolved_comment_count(value: &Value) -> Option<usize> {
    Some(
        value
            .as_array()?
            .iter()
            .filter(|comment| {
                comment
                    .as_object()
                    .is_some_and(|object| object.get("resolved") != Some(&Value::Bool(true)))
            })
            .count(),
    )
}

/// Streaming frontmatter scanner which retains only `library` and `comments`
/// JSON. Irrelevant macro/numbering text is discarded a byte at a time, so a
/// closing delimiter may occur arbitrarily far into the file without growing a
/// raw-frontmatter buffer or a Tauri bridge payload.
struct FrontmatterIndexScanner {
    opening: bool,
    inside: bool,
    stopped: bool,
    closed: bool,
    line_prefix: Vec<u8>,
    key_disabled: bool,
    capture: Option<IndexField>,
    capture_bytes: Vec<u8>,
    capture_started: bool,
    capture_depth: i64,
    capture_in_string: bool,
    capture_escape: bool,
    capture_discarded: bool,
    index: NativeIndex,
}

impl FrontmatterIndexScanner {
    fn new() -> Self {
        Self {
            opening: true,
            inside: false,
            stopped: false,
            closed: false,
            line_prefix: Vec::with_capacity(10),
            key_disabled: false,
            capture: None,
            capture_bytes: Vec::new(),
            capture_started: false,
            capture_depth: 0,
            capture_in_string: false,
            capture_escape: false,
            capture_discarded: false,
            index: NativeIndex::default(),
        }
    }

    fn feed(&mut self, bytes: &[u8]) {
        for byte in bytes {
            if self.stopped {
                break;
            }
            self.feed_byte(*byte);
        }
    }

    fn feed_byte(&mut self, byte: u8) {
        if byte == b'\n' {
            self.finish_line();
            return;
        }
        if byte != b'\r' && self.line_prefix.len() < 10 {
            self.line_prefix.push(byte);
        }

        if self.opening {
            if !b"---".starts_with(&self.line_prefix) {
                self.stopped = true;
            }
            return;
        }
        if !self.inside {
            return;
        }
        if self.capture.is_some() {
            self.capture_byte(byte);
            return;
        }
        if self.key_disabled {
            return;
        }
        if self.line_prefix == b"library:" {
            self.begin_capture(IndexField::Library);
        } else if self.line_prefix == b"comments:" {
            self.begin_capture(IndexField::Comments);
        } else if !b"library:".starts_with(&self.line_prefix)
            && !b"comments:".starts_with(&self.line_prefix)
        {
            self.key_disabled = true;
        }
    }

    fn finish_line(&mut self) {
        if self.opening {
            if self.line_prefix == b"---" {
                self.opening = false;
                self.inside = true;
            } else {
                self.stopped = true;
            }
            self.reset_line();
            return;
        }
        if self.inside && self.line_prefix == b"---" {
            self.closed = true;
            self.inside = false;
            self.stopped = true;
            return;
        }
        if self.capture.is_some() {
            if self.capture_started {
                self.retain_capture_byte(b'\n');
            } else {
                self.cancel_capture();
            }
        }
        self.reset_line();
    }

    fn reset_line(&mut self) {
        self.line_prefix.clear();
        self.key_disabled = false;
    }

    fn begin_capture(&mut self, field: IndexField) {
        self.capture = Some(field);
        self.capture_bytes.clear();
        self.capture_started = false;
        self.capture_depth = 0;
        self.capture_in_string = false;
        self.capture_escape = false;
        self.capture_discarded = false;
    }

    fn cancel_capture(&mut self) {
        self.capture = None;
        self.capture_bytes.clear();
        self.capture_started = false;
        self.capture_discarded = false;
        self.key_disabled = true;
    }

    fn retain_capture_byte(&mut self, byte: u8) {
        if self.capture_discarded {
            return;
        }
        if self.capture_bytes.len() >= MAX_RETAINED_INDEX_FIELD_BYTES {
            let field = match self.capture {
                Some(IndexField::Library) => "library",
                Some(IndexField::Comments) => "comments",
                None => "frontmatter",
            };
            eprintln!("MdLyx {field} JSON exceeds the indexing limit and was ignored");
            self.capture_bytes.clear();
            self.capture_discarded = true;
            return;
        }
        self.capture_bytes.push(byte);
    }

    fn capture_byte(&mut self, byte: u8) {
        if !self.capture_started {
            if byte.is_ascii_whitespace() {
                return;
            }
            if byte != b'[' && byte != b'{' {
                self.cancel_capture();
                return;
            }
            self.capture_started = true;
        }

        self.retain_capture_byte(byte);
        if self.capture_escape {
            self.capture_escape = false;
            return;
        }
        if self.capture_in_string {
            if byte == b'\\' {
                self.capture_escape = true;
            } else if byte == b'"' {
                self.capture_in_string = false;
            }
            return;
        }
        match byte {
            b'"' => self.capture_in_string = true,
            b'[' | b'{' => self.capture_depth += 1,
            b']' | b'}' => self.capture_depth -= 1,
            _ => {}
        }
        if self.capture_depth != 0 {
            return;
        }

        let field = self.capture.take().expect("capture field exists");
        if !self.capture_discarded {
            if let Ok(value) = serde_json::from_slice::<Value>(&self.capture_bytes) {
                match field {
                    IndexField::Library => {
                        if let Some(meta) = compact_library_meta(&value) {
                            self.index.meta = meta;
                        }
                    }
                    IndexField::Comments => {
                        if let Some(count) = unresolved_comment_count(&value) {
                            self.index.open_comment_count = count;
                        }
                    }
                }
            }
        }
        self.capture_bytes.clear();
        self.capture_started = false;
        self.capture_discarded = false;
        self.key_disabled = true;
    }

    fn finish(&mut self) {
        if !self.stopped && !self.opening && self.line_prefix == b"---" {
            self.closed = true;
        }
        self.stopped = true;
    }

    fn into_index(self) -> NativeIndex {
        if self.closed {
            self.index
        } else {
            NativeIndex::default()
        }
    }
}

fn read_index_data<R: Read>(reader: &mut R) -> io::Result<NativeIndex> {
    let mut scanner = FrontmatterIndexScanner::new();

    // Probe an opening delimiter one byte at a time. Ordinary Markdown files
    // stop after the first mismatching byte instead of reading/copying 64 KiB.
    while scanner.opening && !scanner.stopped {
        let mut byte = [0_u8; 1];
        if reader.read(&mut byte)? == 0 {
            scanner.finish();
            return Ok(scanner.into_index());
        }
        scanner.feed(&byte);
    }

    let mut chunk = [0_u8; INDEX_HEAD_BYTES];
    while !scanner.stopped {
        let read = reader.read(&mut chunk)?;
        if read == 0 {
            scanner.finish();
            break;
        }
        scanner.feed(&chunk[..read]);
    }
    Ok(scanner.into_index())
}

fn index_file(path: &Path) -> NativeIndex {
    let Ok(mut file) = File::open(path) else {
        return NativeIndex::default();
    };
    read_index_data(&mut file).unwrap_or_default()
}

fn collect_library(
    root: &Path,
    directory: &Path,
    relative: &Path,
    depth: usize,
    entries: &mut Vec<NativeLibraryEntry>,
) -> Result<(), String> {
    if depth > MAX_LIBRARY_DEPTH {
        return Ok(());
    }
    let children = fs::read_dir(directory).map_err(|error| error.to_string())?;
    for child in children {
        let child = child.map_err(|error| error.to_string())?;
        let name = child.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let file_type = child.file_type().map_err(|error| error.to_string())?;
        if file_type.is_symlink() {
            continue;
        }
        let child_relative = relative.join(&name);
        if file_type.is_dir() {
            collect_library(root, &child.path(), &child_relative, depth + 1, entries)?;
        } else if file_type.is_file() && markdown_name(&name) {
            let path = child.path();
            let canonical = path.canonicalize().map_err(|error| error.to_string())?;
            if !canonical.starts_with(root) {
                continue;
            }
            let index = index_file(&canonical);
            entries.push(NativeLibraryEntry {
                name,
                folder: child_relative
                    .parent()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default()
                    .replace('\\', "/"),
                path: canonical.to_string_lossy().into_owned(),
                meta: index.meta,
                open_comment_count: index.open_comment_count,
            });
        }
    }
    Ok(())
}

fn collect_assets(
    root: &Path,
    directory: &Path,
    relative: &Path,
    depth: usize,
    entries: &mut Vec<NativeAssetEntry>,
) -> Result<(), String> {
    if depth > MAX_LIBRARY_DEPTH {
        return Ok(());
    }
    for child in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let child = child.map_err(|error| error.to_string())?;
        let name = child.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let file_type = child.file_type().map_err(|error| error.to_string())?;
        if file_type.is_symlink() {
            continue;
        }
        let child_relative = relative.join(&name);
        if file_type.is_dir() {
            collect_assets(root, &child.path(), &child_relative, depth + 1, entries)?;
        } else if file_type.is_file() && asset_name(&name) {
            let canonical = child
                .path()
                .canonicalize()
                .map_err(|error| error.to_string())?;
            if !canonical.starts_with(root) {
                continue;
            }
            let size = fs::metadata(&canonical)
                .map_err(|error| error.to_string())?
                .len() as usize;
            entries.push(NativeAssetEntry {
                path: child_relative.to_string_lossy().replace('\\', "/"),
                size,
                sha: None,
                bytes: None,
            });
        }
    }
    Ok(())
}

fn canonical_library_root(root: String) -> Result<PathBuf, String> {
    let root = PathBuf::from(root)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !root.is_dir() {
        return Err("The selected library folder is not available".into());
    }
    Ok(root)
}

fn list_library_assets(root: String) -> Result<Vec<NativeAssetEntry>, String> {
    let root = canonical_library_root(root)?;
    let mut entries = Vec::new();
    collect_assets(&root, &root, Path::new(""), 0, &mut entries)?;
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(entries)
}

fn read_library_asset(root: String, relative_path: String) -> Result<NativeAssetEntry, String> {
    let root = canonical_library_root(root)?;
    let relative = asset_relative_path(&relative_path)?;
    let target = root.join(&relative);
    let metadata = fs::symlink_metadata(&target).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("Library assets cannot be symbolic links".into());
    }
    let canonical = target.canonicalize().map_err(|error| error.to_string())?;
    if !canonical.starts_with(&root) || !canonical.is_file() {
        return Err("Asset path must stay inside the selected folder".into());
    }
    let bytes = fs::read(&canonical).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_LIBRARY_ASSET_BYTES {
        return Err("Asset exceeds the 25 MiB limit".into());
    }
    Ok(NativeAssetEntry {
        path: relative.to_string_lossy().replace('\\', "/"),
        size: bytes.len(),
        sha: Some(content_sha(&bytes)),
        bytes: Some(bytes),
    })
}

fn write_library_asset(
    root: String,
    relative_path: String,
    bytes: Vec<u8>,
    if_match: Option<String>,
) -> Result<NativeAssetEntry, String> {
    if bytes.len() > MAX_LIBRARY_ASSET_BYTES {
        return Err("Asset exceeds the 25 MiB limit".into());
    }
    let root = canonical_library_root(root)?;
    let relative = asset_relative_path(&relative_path)?;
    let target = root.join(&relative);
    let parent = target.parent().ok_or("Invalid asset path")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let canonical_parent = parent.canonicalize().map_err(|error| error.to_string())?;
    if !canonical_parent.starts_with(&root) {
        return Err("Asset path must stay inside the selected folder".into());
    }
    match fs::symlink_metadata(&target) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err("Library assets cannot be symbolic links".into());
        }
        Ok(metadata) if !metadata.is_file() => return Err("Asset path must identify a file".into()),
        Ok(_) => {
            if let Some(expected) = if_match.as_deref() {
                let current = fs::read(&target).map_err(|error| error.to_string())?;
                if content_sha(&current) != expected {
                    return Err("Asset changed since it was opened".into());
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if if_match.is_some() {
                return Err("Asset changed since it was opened".into());
            }
        }
        Err(error) => return Err(error.to_string()),
    }
    atomic_write(&target, &bytes)?;
    Ok(NativeAssetEntry {
        path: relative.to_string_lossy().replace('\\', "/"),
        size: bytes.len(),
        sha: Some(content_sha(&bytes)),
        bytes: None,
    })
}

#[tauri::command]
fn list_library_files(root: String) -> Result<Vec<NativeLibraryEntry>, String> {
    let root = PathBuf::from(root)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !root.is_dir() {
        return Err("The selected library folder is not available".into());
    }
    let mut entries = Vec::new();
    collect_library(&root, &root, Path::new(""), 0, &mut entries)?;
    entries.sort_by(|a, b| a.folder.cmp(&b.folder).then_with(|| a.name.cmp(&b.name)));
    Ok(entries)
}

#[tauri::command]
fn create_library_file(root: String, relative_path: String) -> Result<NativeOpenedFile, String> {
    let root = PathBuf::from(root)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !root.is_dir() {
        return Err("The selected library folder is not available".into());
    }
    let relative = library_relative_path(&relative_path)?;
    let target = root.join(&relative);
    let parent = target.parent().ok_or("Invalid library document path")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let canonical_parent = parent.canonicalize().map_err(|error| error.to_string())?;
    if !canonical_parent.starts_with(&root) {
        return Err("Library path must stay inside the selected folder".into());
    }
    match fs::symlink_metadata(&target) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err("Library documents cannot be symbolic links".into());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::write(&target, "").map_err(|error| error.to_string())?;
        }
        Err(error) => return Err(error.to_string()),
    }
    let canonical = target.canonicalize().map_err(|error| error.to_string())?;
    if !canonical.starts_with(&root) || !canonical.is_file() {
        return Err("Library path must identify a file inside the selected folder".into());
    }
    let text = fs::read_to_string(&canonical).map_err(|error| error.to_string())?;
    Ok(NativeOpenedFile {
        name: canonical
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("untitled.md")
            .to_string(),
        path: canonical.to_string_lossy().into_owned(),
        text,
    })
}

#[tauri::command]
async fn native_pick_library_root(
    app: tauri::AppHandle,
    grants: tauri::State<'_, NativeGrants>,
) -> Result<Option<NativeRootGrant>, String> {
    let selected = app.dialog().file().blocking_pick_folder();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected.into_path().map_err(|error| error.to_string())?;
    let canonical = canonical_native_root(&path)?;
    let name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Library")
        .to_string();
    let (grant_id, identity) = add_root_grant_with_identity(&grants, canonical)?;
    Ok(Some(NativeRootGrant {
        grant_id,
        identity,
        name,
    }))
}

#[tauri::command]
fn native_reconnect_library_root(
    grants: tauri::State<'_, NativeGrants>,
    identity: String,
) -> Result<Option<NativeRootGrant>, String> {
    reconnect_root_by_identity(&grants, &identity)
}

#[tauri::command]
fn native_library_grant_available(
    grants: tauri::State<'_, NativeGrants>,
    grant_id: String,
) -> bool {
    validated_granted_root(&grants, &grant_id).is_ok()
}

#[tauri::command]
fn native_list_library(
    grants: tauri::State<'_, NativeGrants>,
    grant_id: String,
) -> Result<Vec<GrantedLibraryEntry>, String> {
    let root = validated_granted_root(&grants, &grant_id)?;
    let entries = list_library_files(root.to_string_lossy().into_owned())?;
    let paths = entries
        .iter()
        .map(|entry| PathBuf::from(&entry.path))
        .collect::<Vec<_>>();
    let identities = file_identities_for_paths(&grants, &paths)?;
    entries
        .into_iter()
        .map(|entry| {
            let path = PathBuf::from(&entry.path);
            let file_grant = add_file_grant(&grants, path.clone())?;
            let identity = identities
                .get(&path)
                .cloned()
                .ok_or("Native file identity is unavailable")?;
            Ok(GrantedLibraryEntry {
                name: entry.name,
                folder: entry.folder,
                grant_id: file_grant,
                identity,
                meta: entry.meta,
                open_comment_count: entry.open_comment_count,
            })
        })
        .collect()
}

#[tauri::command]
fn native_create_library_file(
    grants: tauri::State<'_, NativeGrants>,
    grant_id: String,
    relative_path: String,
) -> Result<NativeFileGrant, String> {
    let root = validated_granted_root(&grants, &grant_id)?;
    let opened = create_library_file(root.to_string_lossy().into_owned(), relative_path)?;
    let (grant_id, identity) = add_file_grant_with_identity(&grants, PathBuf::from(&opened.path))?;
    Ok(NativeFileGrant {
        grant_id,
        identity,
        name: opened.name,
        text: opened.text,
    })
}

#[tauri::command]
fn native_list_assets(
    grants: tauri::State<'_, NativeGrants>,
    grant_id: String,
) -> Result<Vec<NativeAssetEntry>, String> {
    let root = validated_granted_root(&grants, &grant_id)?;
    list_library_assets(root.to_string_lossy().into_owned())
}

#[tauri::command]
fn native_read_asset(
    grants: tauri::State<'_, NativeGrants>,
    grant_id: String,
    relative_path: String,
) -> Result<NativeAssetEntry, String> {
    let root = validated_granted_root(&grants, &grant_id)?;
    read_library_asset(root.to_string_lossy().into_owned(), relative_path)
}

#[tauri::command]
fn native_write_asset(
    grants: tauri::State<'_, NativeGrants>,
    grant_id: String,
    relative_path: String,
    bytes: Vec<u8>,
    if_match: Option<String>,
) -> Result<NativeAssetEntry, String> {
    let root = validated_granted_root(&grants, &grant_id)?;
    write_library_asset(
        root.to_string_lossy().into_owned(),
        relative_path,
        bytes,
        if_match,
    )
}

#[tauri::command]
fn native_close_library(
    grants: tauri::State<'_, NativeGrants>,
    grant_id: String,
) -> Result<(), String> {
    grants
        .roots
        .lock()
        .map_err(|_| "Native library grants are unavailable")?
        .remove(&grant_id);
    Ok(())
}

fn session_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|e| e.to_string())
}

#[tauri::command]
fn github_session_get() -> Result<Option<String>, String> {
    match session_entry()?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn github_session_set(value: String) -> Result<(), String> {
    session_entry()?
        .set_password(&value)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn github_session_clear() -> Result<(), String> {
    match session_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(NativeGrants::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init());
    builder
        .setup(|app| {
            let identity_store_path = app.path().app_data_dir()?.join(NATIVE_FILE_IDENTITIES_NAME);
            configure_file_identity_store(&app.state::<NativeGrants>(), identity_store_path)
                .map_err(io::Error::other)?;
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            native_pick_file,
            native_save_file,
            native_reconnect_file,
            native_read_file,
            native_read_file_prefix,
            native_write_file,
            native_close_file,
            native_pick_library_root,
            native_reconnect_library_root,
            native_library_grant_available,
            native_list_library,
            native_create_library_file,
            native_list_assets,
            native_read_asset,
            native_write_asset,
            native_close_library,
            github_session_get,
            github_session_set,
            github_session_clear,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEMP_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

    fn temp_root() -> PathBuf {
        let nonce = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("research-library-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn validates_relative_markdown_paths() {
        assert_eq!(
            library_relative_path("drafts/note").unwrap(),
            PathBuf::from("drafts/note.md")
        );
        assert!(library_relative_path("../outside.md").is_err());
        assert!(library_relative_path(".git/config.md").is_err());
        assert!(library_relative_path("reading\\outside.md").is_err());
        assert_eq!(
            library_relative_path("notes.txt").unwrap(),
            PathBuf::from("notes.txt.md")
        );
    }

    #[test]
    fn validates_relative_asset_paths() {
        assert_eq!(
            asset_relative_path("assets/clock.pdf").unwrap(),
            PathBuf::from("assets/clock.pdf")
        );
        assert!(asset_relative_path("../outside.pdf").is_err());
        assert!(asset_relative_path(".git/private.bib").is_err());
        assert!(asset_relative_path("assets/script.sh").is_err());
    }

    #[test]
    fn reads_and_version_guards_native_assets() {
        let root = temp_root();
        let original = vec![0, 1, 2, 255];
        let created = write_library_asset(
            root.to_string_lossy().into_owned(),
            "assets/clock.pdf".into(),
            original.clone(),
            None,
        )
        .unwrap();
        let read = read_library_asset(
            root.to_string_lossy().into_owned(),
            "assets/clock.pdf".into(),
        )
        .unwrap();
        assert_eq!(read.bytes, Some(original));
        assert_eq!(read.sha, created.sha);
        assert!(write_library_asset(
            root.to_string_lossy().into_owned(),
            "assets/clock.pdf".into(),
            vec![9],
            Some("stale".into()),
        )
        .is_err());
        let updated = write_library_asset(
            root.to_string_lossy().into_owned(),
            "assets/clock.pdf".into(),
            vec![9],
            created.sha,
        )
        .unwrap();
        assert_eq!(updated.size, 1);
        assert_eq!(
            list_library_assets(root.to_string_lossy().into_owned())
                .unwrap()
                .len(),
            1
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn native_keychain_backend_is_available() {
        assert!(session_entry().is_ok());
    }

    #[test]
    fn opaque_file_grants_do_not_expose_or_accept_paths() {
        let root = temp_root();
        let path = root.join("proof.md");
        fs::write(&path, "proof").unwrap();
        let grants = NativeGrants::default();
        let grant = add_file_grant(&grants, path.clone()).unwrap();

        assert_ne!(grant, path.to_string_lossy());
        assert_eq!(granted_file(&grants, &grant).unwrap(), path);
        assert!(granted_file(&grants, "../proof.md").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn live_file_grant_refuses_a_file_symlink_substitution() {
        use std::os::unix::fs::symlink;

        let root = temp_root();
        let path = root.join("proof.md");
        let replacement = root.join("replacement.md");
        fs::write(&path, "original").unwrap();
        fs::write(&replacement, "replacement").unwrap();
        let grants = NativeGrants::default();
        let grant = add_file_grant(&grants, path.canonicalize().unwrap()).unwrap();

        fs::remove_file(&path).unwrap();
        symlink(&replacement, &path).unwrap();

        assert!(validated_granted_file(&grants, &grant).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn live_file_grant_refuses_an_ancestor_symlink_substitution() {
        use std::os::unix::fs::symlink;

        let root = temp_root();
        let documents = root.join("documents");
        let parked = root.join("parked-documents");
        let replacement = root.join("replacement-documents");
        fs::create_dir(&documents).unwrap();
        fs::create_dir(&replacement).unwrap();
        let path = documents.join("proof.md");
        fs::write(&path, "original").unwrap();
        fs::write(replacement.join("proof.md"), "replacement").unwrap();
        let grants = NativeGrants::default();
        let grant = add_file_grant(&grants, path.canonicalize().unwrap()).unwrap();

        fs::rename(&documents, &parked).unwrap();
        symlink(&replacement, &documents).unwrap();

        assert!(validated_granted_file(&grants, &grant).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn live_root_grant_refuses_a_library_symlink_substitution() {
        use std::os::unix::fs::symlink;

        let root = temp_root();
        let library = root.join("research-library");
        let parked = root.join("parked-library");
        let replacement = root.join("replacement-library");
        fs::create_dir(&library).unwrap();
        fs::create_dir(&replacement).unwrap();
        let grants = NativeGrants::default();
        let grant = add_root_grant(&grants, library.canonicalize().unwrap()).unwrap();

        fs::rename(&library, &parked).unwrap();
        symlink(&replacement, &library).unwrap();

        assert!(validated_granted_root(&grants, &grant).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn private_atomic_write_is_private_before_content_and_after_rename() {
        let root = temp_root();
        let target = root.join("native-file-identities.json");
        let temporary = root.join(".native-file-identities.test.tmp");
        fs::write(&target, b"old").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o644)).unwrap();

        let mut file =
            open_atomic_temporary(&target, &temporary, AtomicWritePrivacy::Private).unwrap();
        assert_eq!(
            fs::metadata(&temporary).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(fs::metadata(&temporary).unwrap().len(), 0);
        file.write_all(b"private paths").unwrap();
        file.sync_all().unwrap();
        drop(file);
        fs::remove_file(&temporary).unwrap();

        atomic_write_private(&target, b"private identities").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"private identities");
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn persisted_file_identity_reconnects_with_a_fresh_process_grant() {
        let root = temp_root();
        let path = root.join("proof.md");
        let store_path = root.join("app-data/native-file-identities.json");
        fs::write(&path, "durable proof").unwrap();

        let first_process = NativeGrants::default();
        configure_file_identity_store(&first_process, store_path.clone()).unwrap();
        let (first_grant, identity) =
            add_file_grant_with_identity(&first_process, path.clone()).unwrap();
        assert!(valid_native_identity(&identity));
        assert!(!identity.contains(path.to_string_lossy().as_ref()));
        drop(first_process);

        let second_process = NativeGrants::default();
        configure_file_identity_store(&second_process, store_path.clone()).unwrap();
        let reopened = reconnect_file_by_identity(&second_process, &identity)
            .unwrap()
            .expect("remembered document should reconnect");

        assert_eq!(reopened.identity, identity);
        assert_ne!(reopened.grant_id, first_grant);
        assert_eq!(reopened.name, "proof.md");
        assert_eq!(reopened.text, "durable proof");
        assert_eq!(
            granted_file(&second_process, &reopened.grant_id).unwrap(),
            path.canonicalize().unwrap()
        );
        let bridge_payload = serde_json::to_string(&reopened).unwrap();
        assert!(!bridge_payload.contains(path.to_string_lossy().as_ref()));

        #[cfg(unix)]
        assert_eq!(
            fs::metadata(&store_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unknown_and_legacy_file_identities_fail_without_issuing_grants() {
        let root = temp_root();
        let grants = NativeGrants::default();
        configure_file_identity_store(&grants, root.join("app-data/native-file-identities.json"))
            .unwrap();

        assert!(reconnect_file_by_identity(&grants, "legacy-path-or-grant")
            .unwrap()
            .is_none());
        assert!(
            reconnect_file_by_identity(&grants, &Uuid::new_v4().to_string())
                .unwrap()
                .is_none()
        );
        assert!(grants.files.lock().unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn persisted_library_identity_reconnects_with_a_fresh_root_grant() {
        let root = temp_root();
        let library = root.join("research-library");
        let store_path = root.join("app-data/native-file-identities.json");
        fs::create_dir(&library).unwrap();

        let first_process = NativeGrants::default();
        configure_file_identity_store(&first_process, store_path.clone()).unwrap();
        let (first_grant, identity) =
            add_root_grant_with_identity(&first_process, library.clone()).unwrap();
        drop(first_process);

        let second_process = NativeGrants::default();
        configure_file_identity_store(&second_process, store_path).unwrap();
        let reopened = reconnect_root_by_identity(&second_process, &identity)
            .unwrap()
            .expect("remembered library should reconnect");

        assert_eq!(reopened.identity, identity);
        assert_ne!(reopened.grant_id, first_grant);
        assert_eq!(reopened.name, "research-library");
        assert_eq!(
            granted_root(&second_process, &reopened.grant_id).unwrap(),
            library.canonicalize().unwrap()
        );
        let bridge_payload = serde_json::to_string(&reopened).unwrap();
        assert!(!bridge_payload.contains(library.to_string_lossy().as_ref()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unknown_library_identity_fails_without_issuing_a_root_grant() {
        let root = temp_root();
        let grants = NativeGrants::default();
        configure_file_identity_store(&grants, root.join("app-data/native-file-identities.json"))
            .unwrap();

        assert!(reconnect_root_by_identity(&grants, "legacy-root-grant")
            .unwrap()
            .is_none());
        assert!(grants.roots.lock().unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn reconnect_refuses_a_symlink_replacement() {
        use std::os::unix::fs::symlink;

        let root = temp_root();
        let path = root.join("proof.md");
        let outside = root.join("replacement.md");
        fs::write(&path, "original").unwrap();
        fs::write(&outside, "replacement").unwrap();
        let grants = NativeGrants::default();
        configure_file_identity_store(&grants, root.join("app-data/native-file-identities.json"))
            .unwrap();
        let (_, identity) = add_file_grant_with_identity(&grants, path.clone()).unwrap();
        fs::remove_file(&path).unwrap();
        symlink(&outside, &path).unwrap();

        assert!(reconnect_file_by_identity(&grants, &identity).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn reconnect_refuses_a_library_symlink_replacement() {
        use std::os::unix::fs::symlink;

        let root = temp_root();
        let library = root.join("research-library");
        let replacement = root.join("other-library");
        fs::create_dir(&library).unwrap();
        fs::create_dir(&replacement).unwrap();
        let grants = NativeGrants::default();
        configure_file_identity_store(&grants, root.join("app-data/native-file-identities.json"))
            .unwrap();
        let (_, identity) = add_root_grant_with_identity(&grants, library.clone()).unwrap();
        fs::remove_dir(&library).unwrap();
        symlink(&replacement, &library).unwrap();

        assert!(reconnect_root_by_identity(&grants, &identity).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlinked_native_identity_store() {
        use std::os::unix::fs::symlink;

        let root = temp_root();
        let target = root.join("redirected-identities.json");
        let link = root.join("native-file-identities.json");
        fs::write(&target, r#"{"version":1,"files":{},"roots":{}}"#).unwrap();
        symlink(&target, &link).unwrap();

        assert!(configure_file_identity_store(&NativeGrants::default(), link).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn atomic_write_replaces_the_complete_file_without_fixed_temps() {
        let root = temp_root();
        let path = root.join("proof.md");
        fs::write(&path, "old proof").unwrap();

        atomic_write(&path, b"new complete proof").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "new complete proof");
        assert!(fs::read_dir(&root).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".mathdown-")
        }));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn keychain_service_matches_the_public_bundle_identity() {
        assert_eq!(KEYCHAIN_SERVICE, "org.mdlyx.app");
    }

    #[test]
    fn text_prefix_reads_are_bounded_in_utf16_units() {
        let root = temp_root();
        let path = root.join("large.md");
        fs::write(&path, format!("ab😀{}", "x".repeat(2_000_000))).unwrap();

        // JavaScript counts the astral character as two UTF-16 code units.
        assert_eq!(read_text_prefix(&path, 4).unwrap(), "ab😀");
        assert_eq!(read_text_prefix(&path, 5).unwrap(), "ab😀x");
        assert!(read_text_prefix(&path, 0).is_err());
        assert!(read_text_prefix(&path, MAX_TEXT_PREFIX_CHARS + 1).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn indexes_nested_markdown_and_skips_hidden_entries() {
        let root = temp_root();
        fs::create_dir_all(root.join("drafts")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join("overview.md"), "# Overview").unwrap();
        fs::write(root.join("drafts/intro.markdown"), "# Intro").unwrap();
        fs::write(root.join("drafts/ignore.txt"), "ignore").unwrap();
        fs::write(root.join(".git/hidden.md"), "hidden").unwrap();
        let files = list_library_files(root.to_string_lossy().into_owned()).unwrap();
        assert_eq!(
            files
                .iter()
                .map(|file| file.name.as_str())
                .collect::<Vec<_>>(),
            vec!["overview.md", "intro.markdown"]
        );
        assert_eq!(files[1].folder, "drafts");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn keeps_complete_frontmatter_beyond_the_initial_index_slice() {
        let root = temp_root();
        let path = root.join("large-frontmatter.md");
        let source = format!(
            "---\nmacros:\n  huge: \"{}\"\ncomments: [{{\"id\":\"open\",\"resolved\":false}}]\n---\nbody must not be copied",
            "x".repeat(INDEX_HEAD_BYTES)
        );
        fs::write(&path, source).unwrap();

        let index = index_file(&path);
        assert_eq!(index.open_comment_count, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn parses_multiline_index_json_without_returning_raw_frontmatter() {
        let source = format!(
            "---\nmacros:\n  huge: \"{}\"\nlibrary: {{\n  \"id\": \"large\",\n  \"visibility\": \"support\",\n  \"projects\": [\"test\"]\n}}\ncomments: [\n  {{\"id\":\"still-open\",\"resolved\":false}},\n  {{\"id\":\"closed\",\"resolved\":true}}\n]\n---\nbody",
            "x".repeat(INDEX_HEAD_BYTES)
        );
        let mut reader = Cursor::new(source.as_bytes());
        let index = read_index_data(&mut reader).unwrap();
        assert_eq!(index.meta["id"], "large");
        assert_eq!(index.meta["visibility"], "support");
        assert_eq!(index.meta["projects"][0], "test");
        assert_eq!(index.open_comment_count, 1);
        assert!(serde_json::to_vec(&index.meta).unwrap().len() < 256);
    }

    #[test]
    fn streams_valid_frontmatter_that_closes_beyond_eight_mib() {
        let source = format!(
            "---\nmacros:\n  huge: \"{}\"\nlibrary: {{\"id\":\"past-eight-mib\"}}\ncomments: [{{\"id\":\"past-cap\",\"resolved\":false}}]\n---\nbody",
            "x".repeat(8 * 1024 * 1024 + 256)
        );
        let mut reader = Cursor::new(source.as_bytes());
        let index = read_index_data(&mut reader).unwrap();

        assert_eq!(index.meta["id"], "past-eight-mib");
        assert_eq!(index.open_comment_count, 1);
    }

    #[test]
    fn malformed_frontmatter_never_produces_a_false_zero_from_partial_data() {
        let source = format!(
            "---\ncomments: [{{\"id\":\"unclosed\",\"resolved\":false}}]\n{}",
            "x".repeat(2 * INDEX_HEAD_BYTES)
        );
        let mut reader = Cursor::new(source.as_bytes());
        let index = read_index_data(&mut reader).unwrap();

        assert_eq!(index.open_comment_count, 0);
        assert_eq!(index.meta, empty_meta_value());
    }

    #[test]
    fn caps_a_huge_unterminated_comments_value_while_continuing_the_scan() {
        let prefix = b"---\nlibrary: {\"id\":\"retained-meta\"}\ncomments: [";
        let mut scanner = FrontmatterIndexScanner::new();
        scanner.feed(prefix);
        for _ in 0..(MAX_RETAINED_INDEX_FIELD_BYTES / INDEX_HEAD_BYTES + 1) {
            scanner.feed(&[b'x'; INDEX_HEAD_BYTES]);
        }

        assert!(scanner.capture_discarded);
        assert!(scanner.capture_bytes.len() <= MAX_RETAINED_INDEX_FIELD_BYTES);

        scanner.feed(b"\n---\nbody");
        let index = scanner.into_index();
        assert_eq!(index.meta["id"], "retained-meta");
        assert_eq!(index.open_comment_count, 0);
    }

    #[test]
    fn ordinary_markdown_stops_after_the_first_mismatching_byte() {
        let source = format!("# Ordinary document\n{}", "body".repeat(INDEX_HEAD_BYTES));
        let mut reader = Cursor::new(source.as_bytes());
        let index = read_index_data(&mut reader).unwrap();

        assert_eq!(reader.position(), 1);
        assert_eq!(index.meta, empty_meta_value());
    }

    #[test]
    fn thousand_file_bridge_payload_contains_only_compact_index_data() {
        let root = temp_root();
        for index in 0..1_000 {
            fs::write(
                root.join(format!("document-{index:04}.md")),
                format!("# Document {index}\n{}", "body ".repeat(1_000)),
            )
            .unwrap();
        }

        let files = list_library_files(root.to_string_lossy().into_owned()).unwrap();
        let payload = serde_json::to_vec(&files).unwrap();

        assert_eq!(files.len(), 1_000);
        assert!(
            payload.len() < 250_000,
            "bridge payload was {} bytes",
            payload.len()
        );
        assert!(!String::from_utf8_lossy(&payload).contains("body body"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn creates_nested_documents_without_truncating_existing_content() {
        let root = temp_root();
        let opened =
            create_library_file(root.to_string_lossy().into_owned(), "notes/proof".into()).unwrap();
        fs::write(&opened.path, "preserved").unwrap();
        let reopened =
            create_library_file(root.to_string_lossy().into_owned(), "notes/proof.md".into())
                .unwrap();
        assert_eq!(reopened.text, "preserved");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_document_symlink_that_escapes_the_root() {
        use std::os::unix::fs::symlink;

        let root = temp_root();
        let outside = root
            .parent()
            .unwrap()
            .join(format!("mathdown-outside-{}", std::process::id()));
        let _ = fs::remove_file(&outside);
        symlink(&outside, root.join("escape.md")).unwrap();
        assert!(
            create_library_file(root.to_string_lossy().into_owned(), "escape.md".into()).is_err()
        );
        assert!(!outside.exists());
        fs::remove_dir_all(root).unwrap();
    }
}
