// Third-party notices for everything the app ships, generated at build time so they
// always match what's actually in it:
// - every npm package that ends up in the bundled page (from Vite's module graph),
//   with the license text from the package (or from licenses/ when the package has none);
// - the fonts, with their license texts from licenses/fonts/.
// Writes dist/THIRD_PARTY_NOTICES.txt (copied into the app) and ../THIRD_PARTY_NOTICES.md
// (the repository's copy; CI checks it is up to date).
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const VENDORED = join(WEB, "licenses");
const REPO_NOTICES = join(WEB, "..", "THIRD_PARTY_NOTICES.md");

/** The fonts copied from @excalidraw/excalidraw (see copy-fonts.mjs). */
const FONTS = [
  { name: "Excalifont", license: "OFL-1.1", url: "https://github.com/excalidraw/excalidraw/tree/master/packages/excalidraw/fonts/Excalifont" },
  { name: "Virgil", license: "OFL-1.1", url: "https://github.com/excalidraw/virgil" },
  { name: "Xiaolai", title: "Xiaolai SC (小赖字体)", license: "OFL-1.1", url: "https://github.com/excalidraw/excalidraw/tree/master/packages/excalidraw/fonts/Xiaolai" },
  { name: "Nunito", license: "OFL-1.1", url: "https://github.com/googlefonts/nunito" },
  { name: "Lilita", title: "Lilita One", license: "OFL-1.1", url: "https://fonts.google.com/specimen/Lilita+One" },
  { name: "ComicShanns", title: "Comic Shanns Mono", license: "MIT", url: "https://github.com/excalidraw/excalidraw/tree/master/packages/excalidraw/fonts/ComicShanns" },
  { name: "Cascadia", title: "Cascadia Code", license: "OFL-1.1", url: "https://github.com/microsoft/cascadia-code" },
  { name: "Liberation", title: "Liberation Sans", license: "OFL-1.1", url: "https://github.com/liberationfonts/liberation-fonts" },
  { name: "Assistant", license: "OFL-1.1", url: "https://github.com/hafontia/Assistant" },
];

/** ".../node_modules/@scope/name/dist/x.js" -> ".../node_modules/@scope/name" */
function packageDir(id) {
  const path = id.split("?")[0].replaceAll("\\", "/");
  const at = path.lastIndexOf("/node_modules/");
  if (at < 0 || path.startsWith("\0")) return null;
  const rest = path.slice(at + "/node_modules/".length).split("/");
  const depth = rest[0].startsWith("@") ? 2 : 1;
  return path.slice(0, at) + "/node_modules/" + rest.slice(0, depth).join("/");
}

function licenseText(dir, name) {
  const files = readdirSync(dir).sort(); // same choice on every file system
  const file = files.find((f) => /^(licen[cs]e|copying)([.-](md|txt|markdown|mit))?$/i.test(f));
  // Apache-2.0 asks for a package's NOTICE file to go along too
  const notice = files.find((f) => /^notice(\.(md|txt))?$/i.test(f));
  const extra = notice ? `\n\n${readFileSync(join(dir, notice), "utf8").trim()}` : "";
  if (file) return readFileSync(join(dir, file), "utf8").trim() + extra;
  // licenses/<scope>__<name>.txt, or licenses/<scope>.txt for a whole scope (@radix-ui)
  const candidates = [`${name.replace("/", "__")}.txt`];
  if (name.startsWith("@")) candidates.push(`${name.split("/")[0]}.txt`);
  for (const file of candidates) {
    if (existsSync(join(VENDORED, file))) return readFileSync(join(VENDORED, file), "utf8").trim();
  }
  throw new Error(`third-party notices: no license text for ${name} (add licenses/${name.replace("/", "__")}.txt)`);
}

/** package.json's license, or (when it declares none) the one its license text names. */
function licenseId(pkg, text) {
  const declared = typeof pkg.license === "string" ? pkg.license : pkg.license?.type ?? pkg.licenses?.[0]?.type;
  if (declared) return declared;
  const head = text.slice(0, 200);
  if (/\bMIT License\b/i.test(head)) return "MIT";
  if (/\bISC License\b/i.test(head)) return "ISC";
  if (/Apache License,? Version 2\.0/i.test(head)) return "Apache-2.0";
  throw new Error(`third-party notices: can't tell the license of ${pkg.name}`);
}

function repositoryUrl(pkg) {
  const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  const url = (repo ?? pkg.homepage ?? "")
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/\.git$/, "")
    .replace(/^github:/, "https://github.com/");
  return /^[\w-]+\/[\w.-]+$/.test(url) ? `https://github.com/${url}` : url;
}

function collectPackages(moduleIds) {
  const packages = new Map();
  for (const id of moduleIds) {
    const dir = packageDir(id);
    if (!dir || packages.has(dir)) continue;
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const text = licenseText(dir, pkg.name);
    packages.set(dir, {
      name: pkg.name,
      version: pkg.version,
      license: licenseId(pkg, text),
      url: repositoryUrl(pkg),
      text,
    });
  }
  // one entry per name@version, sorted
  const unique = new Map([...packages.values()].map((p) => [`${p.name}@${p.version}`, p]));
  const key = (p) => `${p.name}@${p.version}`;
  return [...unique.values()].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

function fonts() {
  return FONTS.map((f) => ({ ...f, text: readFileSync(join(VENDORED, "fonts", `${f.name}.txt`), "utf8").trim() }));
}

const INTRO =
  "Excalidraw for Mac is an unofficial Mac app built around Excalidraw. It is not made by or affiliated with the Excalidraw team.\n" +
  "It includes the following third-party software and fonts, each under its own license, reproduced below.";

function renderText(packages, fontList) {
  const rule = "-".repeat(78);
  const parts = [`THIRD-PARTY NOTICES\n\n${INTRO}\n`];
  parts.push(`${rule}\nFONTS\n${rule}`);
  for (const f of fontList) parts.push(`${f.title ?? f.name} (${f.license})\n${f.url}\n\n${f.text}\n\n${rule}`);
  parts.push(`SOFTWARE\n${rule}`);
  for (const p of packages) parts.push(`${p.name} ${p.version} (${p.license})\n${p.url}\n\n${p.text}\n\n${rule}`);
  return parts.join("\n\n") + "\n";
}

function renderMarkdown(packages, fontList) {
  const row = (name, license, url) => `| ${url ? `[${name}](${url})` : name} | ${license} |`;
  const details = (title, text) =>
    `<details>\n<summary>${title}</summary>\n\n\`\`\`text\n${text.replaceAll("```", "'''")}\n\`\`\`\n\n</details>`;
  return [
    "# Third-party notices",
    "",
    "<!-- Generated by web/scripts/third-party.mjs during `npm run build`. Do not edit by hand. -->",
    "",
    INTRO,
    "",
    "The app bundles exactly these (they are also in the app: Help › Acknowledgements).",
    "",
    "## Fonts",
    "",
    "| Font | License |",
    "|---|---|",
    ...fontList.map((f) => row(f.title ?? f.name, f.license, f.url)),
    "",
    "## Software",
    "",
    "| Package | License |",
    "|---|---|",
    ...packages.map((p) => row(`${p.name} ${p.version}`, p.license, p.url)),
    "",
    "## License texts",
    "",
    ...fontList.map((f) => details(`${f.title ?? f.name} — ${f.license}`, f.text)),
    "",
    ...packages.map((p) => details(`${p.name} ${p.version} — ${p.license}`, p.text)),
    "",
  ].join("\n");
}

/** Vite plugin: writes the notices for the modules in the production bundle. */
export function thirdPartyNotices() {
  return {
    name: "third-party-notices",
    apply: "build",
    generateBundle() {
      const included = [...this.getModuleIds()].filter((id) => this.getModuleInfo(id)?.isIncluded !== false);
      const packages = collectPackages(included);
      const fontList = fonts();
      this.emitFile({ type: "asset", fileName: "THIRD_PARTY_NOTICES.txt", source: renderText(packages, fontList) });
      writeFileSync(REPO_NOTICES, renderMarkdown(packages, fontList));
    },
  };
}
