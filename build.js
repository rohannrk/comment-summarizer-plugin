// Build: compiles src/code.ts -> dist/code.js and bundles src/ui.ts inline into dist/ui.html.
// Usage: node build.js [--watch]

const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const watch = process.argv.includes("--watch");
const prod = process.argv.includes("--prod");
const outdir = path.join(__dirname, "dist");
fs.mkdirSync(outdir, { recursive: true });

const htmlTemplate = path.join(__dirname, "src", "ui.html");

// Plugin that, after each UI build, injects the bundled JS into ui.html.
const inlineUiPlugin = {
  name: "inline-ui-html",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length) return;
      const js = result.outputFiles.find((f) => f.path.endsWith(".js"));
      if (!js) return;
      const template = fs.readFileSync(htmlTemplate, "utf8");
      const html = template.replace(
        "<!-- SCRIPT -->",
        `<script>${js.text}</script>`
      );
      fs.writeFileSync(path.join(outdir, "ui.html"), html);
      console.log(`[ui] wrote dist/ui.html (${(html.length / 1024).toFixed(1)} kB)`);
    });
  },
};

const codeOptions = {
  entryPoints: [path.join(__dirname, "src", "code.ts")],
  outfile: path.join(outdir, "code.js"),
  bundle: true,
  target: "es2017",
  minify: prod,
  logLevel: "info",
};

const uiOptions = {
  entryPoints: [path.join(__dirname, "src", "ui.ts")],
  bundle: true,
  format: "iife",
  target: "es2017",
  minify: prod,
  write: false, // keep in memory; the plugin inlines it
  outfile: "ui.js",
  plugins: [inlineUiPlugin],
  logLevel: "info",
};

async function main() {
  if (watch) {
    const [codeCtx, uiCtx] = await Promise.all([
      esbuild.context(codeOptions),
      esbuild.context(uiOptions),
    ]);
    await Promise.all([codeCtx.watch(), uiCtx.watch()]);
    console.log("watching…");
  } else {
    await Promise.all([esbuild.build(codeOptions), esbuild.build(uiOptions)]);
    console.log("build complete");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
