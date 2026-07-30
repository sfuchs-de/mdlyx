const major = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);

if (major !== 22) {
  console.error(
    `MdLyx development and release checks require Node 22.x; found Node ${process.versions.node}. `
      + "Switch to Node 22 before running npm scripts.",
  );
  process.exit(1);
}
