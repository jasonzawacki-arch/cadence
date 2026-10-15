// Dependency-free single-file bundler: TypeScript -> CommonJS modules -> one inline <script>, with the demo data
// inlined as JSON. Writes dist/cadence.html and dist/site/ (for GitHub Pages, with the collector script beside it).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let ts;
try {
  ts = require('typescript');
} catch {
  console.error('The "typescript" package is required. Run `npm install` first.');
  process.exit(1);
}
const SRC = 'src', ENTRY = ['app.ts'];
const mods = {};
const add = (name) => {
  if (mods[name]) return;
  const file = path.join(SRC, name);
  const out = ts.transpileModule(fs.readFileSync(file, 'utf8'), { fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } });
  mods[name] = out.outputText;
  for (const m of out.outputText.matchAll(/require\("\.\/([^"]+)"\)/g)) add(m[1].replace(/\.js$/, '.ts'));
};
ENTRY.forEach(add);
let js = '(function(){var M={},C={};function R(n){if(C[n])return C[n].exports;var m=C[n]={exports:{}};M[n](m,m.exports,function(x){return R(x.replace(/^\\.\\//,"").replace(/\\.js$/,".ts"))});return m.exports}\n';
for (const [n, c] of Object.entries(mods)) js += 'M[' + JSON.stringify(n) + ']=function(module,exports,require){\n' + c + '\n};\n';
js += JSON.stringify(ENTRY) + '.forEach(R);})();';
js = js.replace(/<\/script/gi, '<\\/script');
const demo = JSON.stringify(JSON.parse(fs.readFileSync('src/data/demo.json', 'utf8'))).replace(/<\//g, '<\\/');
const html = fs.readFileSync(path.join(SRC, 'index.template.html'), 'utf8')
  .replace('/*CSS*/', () => fs.readFileSync(path.join(SRC, 'style.css'), 'utf8'))
  .replace('/*DEMO*/', () => demo)
  .replace('/*JS*/', () => '\n' + js + '\n');
fs.mkdirSync('dist/site', { recursive: true });
fs.writeFileSync('dist/cadence.html', html);
fs.writeFileSync('dist/site/index.html', html);
fs.copyFileSync('collect/cadence_collect.py', 'dist/site/cadence_collect.py');
fs.writeFileSync('dist/site/.nojekyll', '');
console.log(`dist/cadence.html ${(html.length / 1024).toFixed(0)} KB; dist/site/`);
