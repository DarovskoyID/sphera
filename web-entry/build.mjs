import {build} from 'esbuild';
import {mkdir,copyFile} from 'node:fs/promises';
await mkdir('dist',{recursive:true});
await build({entryPoints:['src/main.ts'],bundle:true,format:'esm',target:'es2022',minify:true,outdir:'dist'});
await copyFile('index.html','dist/index.html');
