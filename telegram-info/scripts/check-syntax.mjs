import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root=fileURLToPath(new URL('../',import.meta.url));
let checked=0;
for(const directory of ['src','scripts','test']) {
  for(const file of readdirSync(resolve(root,directory),{recursive:true}).filter(file=>file.endsWith('.mjs')).sort()) {
    const result=spawnSync(process.execPath,['--check',resolve(root,directory,file)],{stdio:'inherit'});
    if(result.error) throw result.error;
    if(result.status!==0) process.exit(result.status||1);
    checked++;
  }
}
console.log(`Syntax OK: ${checked} modules`);
