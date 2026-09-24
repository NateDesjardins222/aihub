import { loadImage, createCanvas } from '@napi-rs/canvas';
import { writeFileSync } from 'node:fs';
const img = await loadImage(process.argv[2]);
const w=img.width,h=img.height;
const c=createCanvas(w,h); const ctx=c.getContext('2d'); ctx.drawImage(img,0,0,w,h);
const {data}=ctx.getImageData(0,0,w,h);
function longRun(y,thresh){let best=0,bs=0,be=0,rs=-1;for(let x=0;x<w;x++){const i=(y*w+x)*4;const l=0.2126*data[i]+0.7152*data[i+1]+0.0722*data[i+2];if(l>thresh){if(rs<0)rs=x;}else{if(rs>=0){if(x-rs>best){best=x-rs;bs=rs;be=x-1;}rs=-1;}}}if(rs>=0&&w-rs>best){best=w-rs;bs=rs;be=w-1;}return{best,bs,be};}
function lines(minLen,x0,x1,y0,y1,th){const segs=[];let cur=null;for(let y=Math.floor(h*y0);y<Math.floor(h*y1);y++){const r=longRun(y,th);const cx=(r.bs+r.be)/2;if(r.best>=minLen&&cx>=w*x0&&cx<=w*x1){if(!cur)cur={y0:y,y1:y,bs:r.bs,be:r.be};else{cur.y1=y;cur.bs=r.bs;cur.be=r.be;}}else if(cur){segs.push(cur);cur=null;}}if(cur)segs.push(cur);return segs.map(s=>({y:Math.round((s.y0+s.y1)/2),xc:Math.round((s.bs+s.be)/2),xEnd:s.be,w:s.be-s.bs+1}));}
console.log('dims',w,'x',h);
console.log('central', JSON.stringify(lines(Math.floor(w*0.16),0.25,0.75,0.45,0.82,70)));
console.log('date', JSON.stringify(lines(Math.floor(w*0.08),0.62,0.98,0.05,0.22,90)));
writeFileSync(process.argv[3], c.toBuffer('image/png'));
console.log('saved',process.argv[3]);
