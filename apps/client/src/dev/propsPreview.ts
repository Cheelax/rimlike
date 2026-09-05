/** Scène de revue visuelle : tampons synthétiques, aucune sauvegarde ni simulation. */
import { Renderer } from '../render/Renderer';
import { acquireGl } from '../render/gl';
import { FEATURE as F, TERRAIN as T } from '../render/terrain';
// Le canevas de la page cède la place au conteneur du canevas partagé
// (`render/gl.ts`) : ici comme dans le jeu, un seul contexte WebGL par onglet.
const host = document.createElement('div');
host.className = 'scene';
host.style.cssText = 'position:fixed;inset:0;touch-action:none';
document.querySelector('canvas')?.replaceWith(host);
const gl = acquireGl();
gl.attach(host);
const r = new Renderer(gl, host);
const width=32, height=26;
const tiles=new Uint8Array(width*height).fill(T.Grass), features=new Uint8Array(width*height), zones=new Uint8Array(width*height);
const at=(x:number,z:number)=>z*width+x;
for(let z=6;z<22;z++)for(let x=6;x<27;x++)tiles[at(x,z)]=T.Dirt;
function room(x:number,z:number,w:number,h:number,stone:boolean){
 for(let dz=0;dz<h;dz++)for(let dx=0;dx<w;dx++){
  tiles[at(x+dx,z+dz)]=T.WoodFloor;
  if(dx===0||dz===0||dx===w-1||dz===h-1)features[at(x+dx,z+dz)]=stone?F.WallStone:F.WallWood;
 }
 features[at(x+Math.floor(w/2),z+h-1)]=stone?F.DoorStone:F.DoorWood;
}
room(8,7,7,6,true);room(19,7,6,6,false);room(8,16,7,5,true);
features[at(10,9)]=F.Campfire;
features[at(20,9)]=features[at(22,9)]=F.CraftingSpot;
for(const x of [9,11,13])features[at(x,17)]=F.Bed;
for(let z=16;z<21;z++)for(let x=20;x<25;x++){zones[at(x,z)]=2;features[at(x,z)]=(x+z)%3?F.CropRipe:F.Crop;}
for(const [x,z,f] of [[4,6,F.Tree],[5,11,F.Tree],[4,18,F.Tree],[8,4,F.Tree],[15,4,F.Tree],[26,5,F.Tree],[28,12,F.Tree],[28,20,F.Tree],[17,23,F.Tree],[6,23,F.Tree],[3,14,F.Rock],[28,16,F.Rock],[20,4,F.Rock],[10,23,F.Bush],[3,9,F.Bush],[24,23,F.BushUnripe]])features[at(x,z)]=f;
for(let z=7;z<12;z++)for(let x=16;x<18;x++)zones[at(x,z)]=1;
r.setMap(width,height,tiles,features);r.setOverlays(zones,new Uint8Array(width*height));
const indoor=new Uint8Array(width*height);
for(const [x0,z0,x1,z1] of [[9,8,14,12],[20,8,24,12],[9,17,14,20]]) {
  for(let z=z0;z<z1;z++)for(let x=x0;x<x1;x++)indoor[at(x,z)]=1;
}
// Une bande de dallage extérieure permet de vérifier l'enneigement hors des pièces.
for(let x=15;x<19;x++)tiles[at(x,21)]=T.StoneFloor;
r.setMap(width,height,tiles,features);r.setIndoor(indoor);
const items:number[]=[];for(let i=0;i<16;i++)items.push(i,i,40,7+i%8*2,23+Math.floor(i/8));items.push(20,0,70,16,8,21,1,70,17,8,22,2,50,16,10);r.syncItems(new Int32Array(items));
const plans=new Int32Array([0,0,1,16,17,0,8,0,1,0,1,16,18,8,8,0,2,1,0,16,19,0,8,0,3,3,0,17,19,0,8,0,4,5,0,17,17,0,8,0]);r.syncBlueprints(plans);
const p:number[]=[];for(const [i,x,z,flags,carry] of [[0,6.5,13.5,16,0],[1,16,14,0,0],[2,16,16,4,0],[3,23,10.6,4,0],[4,22,19,4,0]])p.push(i,Math.round(x*256),Math.round(z*256),flags,900000,900000,900000,0,carry,5,0,1000);
r.syncPawns(new Int32Array(p),null,1);
// Cadrage réservé à cette revue de développement, jamais appliqué à une partie.
const view=r as unknown as {camera:{zoom:number;updateProjectionMatrix():void}};
view.camera.zoom=2.15;view.camera.updateProjectionMatrix();
r.setTimeOfDay(0.4);
let snow=false,night=false,show=true;
document.querySelector('#rotate')!.addEventListener('click',()=>r.rotate(1));
document.querySelector('#snow')!.addEventListener('click',()=>{snow=!snow;r.setWeather(snow?3:0);r.setTimeOfDay(night?0.05:0.4)});
document.querySelector('#night')!.addEventListener('click',()=>{night=!night;r.setTimeOfDay(night?0.05:0.4)});
document.querySelector('#plans')!.addEventListener('click',()=>{show=!show;r.syncBlueprints(show?plans:new Int32Array())});
let previous=performance.now();
let frameId=0;
function frame(now:number){
  r.render(Math.min((now-previous)/1000,0.05));
  previous=now;
  frameId=requestAnimationFrame(frame);
}
frameId=requestAnimationFrame(frame);
window.addEventListener("pagehide",()=>{cancelAnimationFrame(frameId);r.dispose();gl.detach(host);gl.release()},{once:true});
