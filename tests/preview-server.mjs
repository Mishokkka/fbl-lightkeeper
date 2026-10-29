import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const core=process.argv.find(arg=>arg.startsWith('--foundry-public='))?.slice('--foundry-public='.length);
const system=process.argv.find(arg=>arg.startsWith('--system-public='))?.slice('--system-public='.length);
const port=Number(process.argv.find(arg=>arg.startsWith('--port='))?.slice('--port='.length)??4173);
if(!Number.isInteger(port) || port<1 || port>65535)throw new Error('Invalid preview port');
const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.svg':'image/svg+xml','.webp':'image/webp','.jpg':'image/jpeg','.png':'image/png'};
http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://127.0.0.1');
    let base=root; let relative=decodeURIComponent(url.pathname);
    if(relative==='/') relative='/tests/preview.html';
    if(relative.startsWith('/core/')) { if(!core) throw Error('No Foundry public directory'); base=path.resolve(core); relative=relative.slice(5); }
    else if(relative.startsWith('/system/')) { if(!system) throw Error('No game system directory'); base=path.resolve(system); relative=relative.slice(7); }
    else if(!/^\/(scripts|styles|tests)\//.test(relative)) throw Error('Unsupported preview path');
    const target=path.resolve(base,'.'+relative);
    if(!target.startsWith(base+path.sep)) throw Error('Outside preview root');
    const content=await fs.readFile(target); res.writeHead(200,{'Content-Type':mime[path.extname(target)]??'text/plain','Cache-Control':'no-store'});res.end(content);
  } catch { res.writeHead(404);res.end('Not found'); }
}).listen(port,'127.0.0.1',()=>console.log(`Lightkeeper preview: http://127.0.0.1:${port}`));
