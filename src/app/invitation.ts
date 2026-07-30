import type { GitHubLibrary } from "./github-library";

export async function renderInvitation(library: GitHubLibrary, token: string | null): Promise<void> {
  document.title = "Accept shared library invitation · MdLyx";
  document.body.textContent = "";
  const main = document.createElement("main");
  main.className = "invite-page";
  const card = document.createElement("section");
  card.className = "invite-card";
  card.setAttribute("aria-labelledby", "invite-title");
  const mark = document.createElement("img");
  mark.src = "/mdlyx-icon.svg";
  mark.alt = "";
  mark.className = "invite-mark";
  const title = document.createElement("h1");
  title.id = "invite-title";
  title.textContent = "Shared MdLyx library";
  const copy = document.createElement("p");
  copy.textContent = "This private, one-time invitation gives you access to specific research projects. No GitHub account or MdLyx password is required.";
  const safety = document.createElement("p");
  safety.className = "invite-note";
  safety.textContent = "The invitation is used only when you accept it. It cannot be reused afterward.";
  const status = document.createElement("p");
  status.className = "invite-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const accept = document.createElement("button");
  accept.type = "button";
  accept.className = "invite-accept";
  accept.textContent = "Accept invitation";
  if (!token) {
    accept.disabled = true;
    accept.textContent = "Invitation unavailable";
    status.className = "invite-status is-error";
    status.textContent = "This invitation link is incomplete or malformed. Ask the library owner for a new link.";
  }
  accept.addEventListener("click", async () => {
    if (!token) return;
    accept.disabled = true;
    accept.textContent = "Accepting…";
    status.textContent = "";
    try {
      const session = await library.redeemInvitation(token);
      if (!session.authenticated) throw new Error("The invitation did not create a shared session.");
      history.replaceState(null, "", "/");
      status.className = "invite-status is-success";
      status.textContent = `Access confirmed${session.principal?.displayName ? ` for ${session.principal.displayName}` : ""}. Opening the shared library…`;
      window.location.replace("/");
    } catch (error) {
      history.replaceState(null, "", "/invite");
      status.className = "invite-status is-error";
      status.textContent = error instanceof Error ? error.message : "This invitation could not be accepted.";
      accept.textContent = "Try invitation again";
      accept.disabled = false;
    }
  });
  card.append(mark, title, copy, safety, accept, status);
  main.append(card);
  document.body.append(main);
  accept.focus();
}
