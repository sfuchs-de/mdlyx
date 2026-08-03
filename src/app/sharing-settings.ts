import { confirmDialog } from "./dialogs";
import type {
  SharedAccessRole,
  SharingAccess,
  SharingInvitation,
} from "./github-library";

export interface SharingSettingsControl {
  sharingAccess?: () => Promise<SharingAccess>;
  createInvitation?: (principalId: string, expiresInSeconds?: number) => Promise<SharingInvitation>;
  revokeInvitation?: (id: string) => Promise<void>;
  createSharingPrincipal?: (
    id: string,
    displayName: string,
    grants: Record<string, SharedAccessRole>,
    expectedPolicySha: string,
  ) => Promise<void>;
  updateSharingPrincipal?: (
    id: string,
    displayName: string,
    grants: Record<string, SharedAccessRole>,
    expectedPolicySha: string,
  ) => Promise<void>;
  revokeSharingSessions?: (id: string, expectedPolicySha: string) => Promise<void>;
  removeSharingPrincipal?: (id: string, expectedPolicySha: string) => Promise<void>;
}

export interface SharingSettingsHandle {
  load(showBusy?: boolean): Promise<void>;
}

const ROLE_LABELS: Record<SharedAccessRole, string> = {
  reader: "Reader",
  commenter: "Commenter",
  editor: "Editor",
};

export function initSharingSettings(
  panel: HTMLElement,
  sync: SharingSettingsControl | undefined,
): SharingSettingsHandle {
  let state: SharingAccess | null = null;
  let busy = false;
  let errorMessage = "";
  let newestInvitation: SharingInvitation | null = null;

  const roleSelect = (selected: SharedAccessRole): HTMLSelectElement => {
    const select = document.createElement("select");
    select.className = "config-sharing-select";
    select.setAttribute("aria-label", "Project role");
    for (const role of ["reader", "commenter", "editor"] as const) {
      const option = document.createElement("option");
      option.value = role;
      option.textContent = ROLE_LABELS[role];
      option.selected = role === selected;
      select.append(option);
    }
    return select;
  };

  const load = async (showBusy = true): Promise<void> => {
    if (!sync?.sharingAccess) return;
    if (showBusy) {
      busy = true;
      render();
    }
    try {
      state = await sync.sharingAccess();
      errorMessage = "";
    } catch (error) {
      errorMessage = message(error, "Could not load sharing access.");
    } finally {
      busy = false;
      render();
    }
  };

  const run = async (change: () => Promise<void>): Promise<void> => {
    busy = true;
    errorMessage = "";
    render();
    try {
      await change();
      await load(false);
    } catch (error) {
      busy = false;
      errorMessage = message(error, "Could not update shared access.");
      render();
    }
  };

  const render = () => {
    panel.textContent = "";
    const heading = document.createElement("h3");
    heading.className = "config-subtitle";
    heading.textContent = "People and project access";
    panel.append(
      heading,
      paragraph(
        "Add each person individually, choose exactly which projects they can use, and assign the least access they need. Project rights remain until revoked; active browser sessions renew automatically after policy revalidation. Changes are committed to the private library access policy.",
        "config-desc",
      ),
    );
    if (busy) {
      panel.append(paragraph("Loading sharing policy…", "config-sync-state"));
      return;
    }
    if (errorMessage) panel.append(paragraph(errorMessage, "config-sync-message"));
    if (!completeControl(sync)) {
      panel.append(paragraph("Sharing controls are unavailable in this build.", "config-desc"));
      return;
    }
    if (!state) {
      panel.append(actions([["Load approved coauthors", () => load()]]));
      return;
    }

    const permissionCount = state.principals.reduce(
      (count, principal) => count + Object.keys(principal.grants).length,
      0,
    );
    panel.append(paragraph(
      `${state.principals.length} ${state.principals.length === 1 ? "person" : "people"} · `
      + `${permissionCount} project ${permissionCount === 1 ? "permission" : "permissions"} · `
      + `${state.invitations.length} outstanding ${state.invitations.length === 1 ? "invitation" : "invitations"}`,
      "config-sharing-summary",
    ));

    const roleGuide = document.createElement("dl");
    roleGuide.className = "config-sharing-role-guide";
    for (const [role, description] of [
      ["Reader", "View documents and project assets"],
      ["Commenter", "View, comment, and reply"],
      ["Editor", "Edit existing project files and comments"],
    ]) {
      const term = document.createElement("dt");
      term.textContent = role;
      const detail = document.createElement("dd");
      detail.textContent = description;
      roleGuide.append(term, detail);
    }
    panel.append(roleGuide, addPersonForm(state, sync, run, roleSelect, () => {
      errorMessage = "Enter a display name, stable user ID, and initial project.";
      render();
    }));

    const peopleHeading = document.createElement("h4");
    peopleHeading.className = "config-sharing-section-heading";
    peopleHeading.textContent = "Approved coauthors";
    panel.append(peopleHeading);
    if (!state.principals.length) panel.append(paragraph("No coauthors are approved yet.", "config-desc"));
    for (const principal of state.principals) {
      panel.append(principalEditor(state, principal, sync, run, roleSelect, (invitation) => {
        newestInvitation = invitation;
      }));
    }

    if (newestInvitation?.url) panel.append(invitationLink(newestInvitation));
    panel.append(outstandingInvitations(state, async (invitation) => {
      try {
        errorMessage = "";
        await sync.revokeInvitation(invitation.id);
        if (newestInvitation?.id === invitation.id) newestInvitation = null;
        await load(false);
      } catch (error) {
        errorMessage = message(error, "Could not revoke invitation.");
        render();
      }
    }));
    panel.append(
      actions([
        ["Refresh", () => load()],
      ]),
      paragraph(
        "Membership is stored in library-access.yaml in the configured library repository.",
        "config-desc",
      ),
      paragraph(
        `Library revision ${state.policyRevision.slice(0, 12)} · policy ${state.policySha.slice(0, 12)}`,
        "config-desc",
      ),
    );
  };

  render();
  return { load };
}

function addPersonForm(
  state: SharingAccess,
  sync: CompleteSharingControl,
  run: (change: () => Promise<void>) => Promise<void>,
  roleSelect: (selected: SharedAccessRole) => HTMLSelectElement,
  invalid: () => void,
): HTMLElement {
  const add = document.createElement("details");
  add.className = "config-sharing-add";
  const summary = document.createElement("summary");
  summary.textContent = "Add coauthor";
  const grid = document.createElement("div");
  grid.className = "config-sharing-form";
  const nameLabel = field("Display name");
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.maxLength = 120;
  nameInput.autocomplete = "off";
  nameLabel.append(nameInput);
  const idLabel = field("Stable user ID");
  const idInput = document.createElement("input");
  idInput.type = "text";
  idInput.maxLength = 63;
  idInput.pattern = "[a-z][a-z0-9-]{1,62}";
  idInput.autocomplete = "off";
  idLabel.append(idInput);
  let idEdited = false;
  idInput.addEventListener("input", () => { idEdited = true; });
  nameInput.addEventListener("input", () => {
    if (idEdited) return;
    idInput.value = nameInput.value.toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63);
  });
  const projectLabel = field("Initial project");
  const projectSelect = document.createElement("select");
  projectSelect.className = "config-sharing-select";
  for (const project of state.projects) {
    const option = document.createElement("option");
    option.value = project.key;
    option.textContent = project.title;
    projectSelect.append(option);
  }
  projectLabel.append(projectSelect);
  const roleLabel = field("Role");
  const initialRole = roleSelect("reader");
  roleLabel.append(initialRole);
  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "config-action config-sharing-form-action";
  addButton.textContent = "Add person";
  addButton.addEventListener("click", () => {
    const project = projectSelect.value;
    if (!nameInput.value.trim() || !idInput.value.trim() || !project) {
      invalid();
      return;
    }
    void run(() => sync.createSharingPrincipal(
      idInput.value.trim(),
      nameInput.value.trim(),
      { [project]: initialRole.value as SharedAccessRole },
      state.policySha,
    ));
  });
  grid.append(nameLabel, idLabel, projectLabel, roleLabel, addButton);
  add.append(
    summary,
    paragraph("The stable ID appears in comment and commit attribution and cannot be renamed later.", "config-desc"),
    grid,
  );
  return add;
}

function principalEditor(
  state: SharingAccess,
  principal: SharingAccess["principals"][number],
  sync: CompleteSharingControl,
  run: (change: () => Promise<void>) => Promise<void>,
  roleSelect: (selected: SharedAccessRole) => HTMLSelectElement,
  issued: (invitation: SharingInvitation) => void,
): HTMLElement {
  const card = document.createElement("article");
  card.className = "config-sharing-principal";
  const header = document.createElement("header");
  const name = document.createElement("h4");
  name.textContent = principal.displayName;
  header.append(name, paragraph(`${principal.id} · access version ${principal.authVersion}`, "config-desc"));
  const nameEditor = field("Display name");
  nameEditor.className = "config-sharing-name";
  const editName = document.createElement("input");
  editName.type = "text";
  editName.maxLength = 120;
  editName.value = principal.displayName;
  nameEditor.append(editName);
  const editableGrants = { ...principal.grants };
  const grantRows = document.createElement("div");
  grantRows.className = "config-sharing-grants-editor";
  const addGrant = document.createElement("div");
  addGrant.className = "config-sharing-add-grant";
  const addProject = document.createElement("select");
  addProject.className = "config-sharing-select";
  addProject.setAttribute("aria-label", `Add project permission for ${principal.displayName}`);
  const addRole = roleSelect("reader");
  const addGrantButton = document.createElement("button");
  addGrantButton.type = "button";
  addGrantButton.className = "config-action";
  addGrantButton.textContent = "Add project";

  const renderAddGrant = () => {
    addProject.textContent = "";
    const available = state.projects.filter((project) => !(project.key in editableGrants));
    for (const project of available) {
      const option = document.createElement("option");
      option.value = project.key;
      option.textContent = project.title;
      addProject.append(option);
    }
    addProject.disabled = !available.length;
    addRole.disabled = !available.length;
    addGrantButton.disabled = !available.length;
  };
  const renderGrantRows = () => {
    grantRows.textContent = "";
    for (const [projectKey, role] of Object.entries(editableGrants)) {
      const row = document.createElement("div");
      row.className = "config-sharing-grant-row";
      const project = state.projects.find((candidate) => candidate.key === projectKey);
      const projectName = document.createElement("span");
      projectName.className = "config-sharing-project";
      projectName.textContent = project?.title ?? projectKey;
      projectName.title = projectKey;
      const projectRole = roleSelect(role);
      projectRole.setAttribute("aria-label", `${project?.title ?? projectKey} role`);
      projectRole.addEventListener("change", () => {
        editableGrants[projectKey] = projectRole.value as SharedAccessRole;
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "config-sharing-remove-grant";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove ${project?.title ?? projectKey} permission`);
      remove.disabled = Object.keys(editableGrants).length <= 1;
      if (remove.disabled) {
        remove.title = "A coauthor must retain one project permission; remove the coauthor instead.";
      }
      remove.addEventListener("click", () => {
        delete editableGrants[projectKey];
        renderGrantRows();
        renderAddGrant();
      });
      row.append(projectName, projectRole, remove);
      grantRows.append(row);
    }
  };
  addGrantButton.addEventListener("click", () => {
    if (!addProject.value) return;
    editableGrants[addProject.value] = addRole.value as SharedAccessRole;
    renderGrantRows();
    renderAddGrant();
  });
  addGrant.append(addProject, addRole, addGrantButton);
  renderGrantRows();
  renderAddGrant();

  const save = action("Save permissions", () => run(() => sync.updateSharingPrincipal(
    principal.id,
    editName.value.trim(),
    editableGrants,
    state.policySha,
  )));
  const revokeSessions = action("Revoke sessions", async () => {
    const confirmed = await confirmDialog(
      `Sign ${principal.displayName} out everywhere and invalidate unused invitations?`,
      { confirmLabel: "Revoke sessions", danger: true },
    );
    if (confirmed) void run(() => sync.revokeSharingSessions(principal.id, state.policySha));
  });
  const remove = action("Remove coauthor", async () => {
    const confirmed = await confirmDialog(
      `Remove ${principal.displayName}'s project access and sign them out?`,
      { confirmLabel: "Remove", danger: true },
    );
    if (confirmed) void run(() => sync.removeSharingPrincipal(principal.id, state.policySha));
  });
  remove.classList.add("is-danger");
  const actionList = document.createElement("div");
  actionList.className = "config-actions";
  actionList.append(save, revokeSessions, remove);

  const inviteExpiry = document.createElement("select");
  inviteExpiry.className = "config-sharing-select";
  inviteExpiry.setAttribute("aria-label", `Invitation expiry for ${principal.displayName}`);
  for (const [label, seconds] of [
    ["1 hour", 3_600],
    ["1 day", 86_400],
    ["3 days", 259_200],
    ["7 days", 604_800],
  ] as const) {
    const option = document.createElement("option");
    option.value = String(seconds);
    option.textContent = label;
    option.selected = seconds === 604_800;
    inviteExpiry.append(option);
  }
  const invite = action("Create invitation", () => run(async () => {
    issued(await sync.createInvitation(principal.id, Number(inviteExpiry.value)));
  }));
  const inviteControls = document.createElement("div");
  inviteControls.className = "config-sharing-invite-controls";
  inviteControls.append(inviteExpiry, invite);
  card.append(header, nameEditor, grantRows, addGrant, actionList, inviteControls);
  return card;
}

function invitationLink(invitation: SharingInvitation): HTMLElement {
  const issued = document.createElement("section");
  issued.className = "config-issued-invite";
  const label = document.createElement("label");
  label.className = "config-label";
  label.textContent = "New invitation link · shown only now";
  const input = document.createElement("input");
  input.readOnly = true;
  input.value = invitation.url ?? "";
  input.setAttribute("aria-label", "New one-time invitation link");
  const copy = action("Copy link", async () => {
    await navigator.clipboard.writeText(invitation.url ?? "");
    copy.textContent = "Copied";
  });
  issued.append(label, input, copy);
  return issued;
}

function outstandingInvitations(
  state: SharingAccess,
  revoke: (invitation: SharingInvitation) => Promise<void>,
): HTMLElement {
  const section = document.createElement("section");
  section.className = "config-sharing-outstanding";
  const heading = document.createElement("h4");
  heading.textContent = "Outstanding invitations";
  section.append(heading);
  if (!state.invitations.length) section.append(paragraph("None.", "config-desc"));
  for (const invitation of state.invitations) {
    const row = document.createElement("div");
    row.className = "config-sharing-invite";
    const principal = state.principals.find((candidate) => candidate.id === invitation.principalId);
    row.append(
      paragraph(
        `${principal?.displayName ?? invitation.principalId} · expires ${new Date(invitation.expiresAt).toLocaleString()}`,
        "config-desc",
      ),
      action("Revoke", () => revoke(invitation)),
    );
    section.append(row);
  }
  return section;
}

type CompleteSharingControl = Required<SharingSettingsControl>;

function completeControl(value: SharingSettingsControl | undefined): value is CompleteSharingControl {
  return Boolean(
    value?.sharingAccess
    && value.createInvitation
    && value.revokeInvitation
    && value.createSharingPrincipal
    && value.updateSharingPrincipal
    && value.revokeSharingSessions
    && value.removeSharingPrincipal,
  );
}

function field(label: string): HTMLLabelElement {
  const element = document.createElement("label");
  element.textContent = label;
  return element;
}

function paragraph(value: string, className: string): HTMLParagraphElement {
  const element = document.createElement("p");
  element.className = className;
  element.textContent = value;
  return element;
}

function action(label: string, run: () => void | Promise<void>): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "config-action";
  button.textContent = label;
  button.addEventListener("click", () => void run());
  return button;
}

function actions(items: Array<[string, () => void | Promise<void>]>): HTMLElement {
  const row = document.createElement("div");
  row.className = "config-actions";
  for (const [label, run] of items) row.append(action(label, run));
  return row;
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
