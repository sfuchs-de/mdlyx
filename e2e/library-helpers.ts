import { expect, type Locator, type Page } from "@playwright/test";

/** Reveal one exact library path through its project disclosure, if needed. */
export async function revealLibraryFile(page: Page, path: string): Promise<Locator> {
  const rowSelector = `.lib-file[data-path=${JSON.stringify(path)}]`;
  const rows = page.locator(`#library ${rowSelector}`);
  for (let index = 0; index < await rows.count(); index += 1) {
    const candidate = rows.nth(index);
    if (await candidate.isVisible()) return candidate;
  }

  // Collapsed project groups intentionally do not construct their file rows.
  // Locate the owning disclosure through the lightweight path index retained
  // on each group. A multi-project document can occur in several groups; the
  // first matching group is a valid instance.
  const sections = page.locator("#library .lib-group-section");
  let section: Locator | null = null;
  let sectionPaths: string[] = [];
  for (let index = 0; index < await sections.count(); index += 1) {
    const candidate = sections.nth(index);
    const paths = await candidate.getAttribute("data-paths");
    if (!paths) continue;
    try {
      const parsed = JSON.parse(paths) as string[];
      if (parsed.includes(path)) {
        section = candidate;
        sectionPaths = parsed;
        break;
      }
    } catch {
      // A malformed test fixture must not make the helper select another row.
    }
  }
  expect(section, `Library group containing ${path}`).not.toBeNull();
  const owningSection = section!;
  await expect(owningSection).toBeAttached();
  const disclosure = owningSection.locator(":scope > .lib-group-head");
  if (await disclosure.getAttribute("aria-expanded") === "false") await disclosure.click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await expect.poll(
    () => owningSection.locator(":scope > .lib-group-body").first().evaluate(
      (body) => body.childElementCount,
    ),
    { message: `Library group containing ${path} should materialize` },
  ).toBeGreaterThan(0);

  // Project views intentionally leave collapsed areas and supporting files
  // unmounted. Open only the disclosure that owns the exact requested path.
  let revealedRow = owningSection.locator(rowSelector).first();
  if (await revealedRow.count() === 0) {
    const disclosures = owningSection.locator(
      ":scope > .lib-group-body > .lib-project-area",
    );
    for (let index = 0; index < await disclosures.count(); index += 1) {
      const disclosure = disclosures.nth(index);
      const paths = await disclosure.getAttribute("data-paths");
      if (!paths) continue;
      try {
        if (!(JSON.parse(paths) as string[]).includes(path)) continue;
        if (await disclosure.getAttribute("open") === null) {
          await disclosure.locator(":scope > summary").click();
        }
        await expect(disclosure).toHaveAttribute("open", "");
        await expect.poll(
          () => disclosure.locator(":scope > .lib-project-area-content").evaluate(
            (content) => content.childElementCount,
          ),
          { message: `Library area containing ${path} should materialize` },
        ).toBeGreaterThan(0);
        break;
      } catch {
        // Ignore malformed test-only state and fall through to the exact-row assertion.
      }
    }
  }

  // Browse areas can contain a second, independently collapsed scholarly
  // section (for example Model derivations → Supply). Reveal only the section
  // owning the target instead of expanding every stage in the model.
  revealedRow = owningSection.locator(rowSelector).first();
  if (await revealedRow.count() === 0) {
    const subsections = owningSection.locator(
      ":scope > .lib-group-body > .lib-project-area[open] .lib-project-subsection",
    );
    for (let index = 0; index < await subsections.count(); index += 1) {
      const subsection = subsections.nth(index);
      const paths = await subsection.getAttribute("data-paths");
      if (!paths) continue;
      try {
        if (!(JSON.parse(paths) as string[]).includes(path)) continue;
        if (await subsection.getAttribute("open") === null) {
          await subsection.locator(":scope > summary").click();
        }
        await expect(subsection).toHaveAttribute("open", "");
        await expect.poll(
          () => subsection.locator(":scope > .lib-project-subsection-content").evaluate(
            (content) => content.childElementCount,
          ),
          { message: `Library subsection containing ${path} should materialize` },
        ).toBeGreaterThan(0);
        break;
      } catch {
        // Ignore malformed test-only state and fall through to the exact-row assertion.
      }
    }
  }

  // Large groups expose a scroll-driven virtual window. Position the owning
  // list near the target's stable index so its row is materialized.
  revealedRow = owningSection.locator(rowSelector).first();
  if (await revealedRow.count() === 0) {
    const targetIndex = sectionPaths.indexOf(path);
    await owningSection.locator(":scope > .lib-group-body").evaluate((body, index) => {
      const list = body.closest<HTMLElement>(".lib-list");
      if (!list || index < 0) return;
      const section = body.closest<HTMLElement>(".lib-group-section");
      const rowHeight = Number(section?.dataset.rowHeight) || 40;
      const bodyTop = body.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
      list.scrollTop = Math.max(0, bodyTop + index * rowHeight - list.clientHeight / 2);
      list.dispatchEvent(new Event("scroll"));
    }, targetIndex);
  }
  // Large Browse sections use bounded windows so hidden rows never exceed the
  // Library's mounted-row budget. Advance until the exact path is present; the
  // section is repository ordered and each click is bounded.
  for (let pageIndex = 0; pageIndex < 20 && await revealedRow.count() === 0; pageIndex += 1) {
    const next = owningSection.getByRole("button", { name: "Next", exact: true }).last();
    if (!await next.count() || await next.isDisabled()) break;
    await next.click();
  }
  await expect(revealedRow).toBeVisible();
  return revealedRow;
}
