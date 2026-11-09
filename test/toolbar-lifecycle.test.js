import test from 'node:test';
import assert from 'node:assert/strict';
import {watchToolbarEntry} from '../src/ui/toolbar-entry.js';
class Element{
 constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.listeners={}}
 append(e){e.parentNode=this;this.children.push(e)}
 after(e){e.parentNode=this.parentNode;const list=this.parentNode.children;list.splice(list.indexOf(this)+1,0,e)}
 remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(e=>e!==this);this.parentNode=null}
 querySelector(){return this.children.find(e=>e.id==='WI-SP-button')??null}
 addEventListener(k,fn){this.listeners[k]=fn}
 setAttribute(k,v){this.attributes[k]=v}
}
test('late/replaced toolbar gets one standalone entry without impersonating a native drawer',()=>{
 const body=new Element('body'),all=e=>[e,...e.children.flatMap(all)];
 const doc={body,createElement:t=>new Element(t),getElementById:id=>all(body).find(e=>e.id===id)??null};let callback,closed=false;const bound=[];
 class Observer{constructor(fn){callback=fn}observe(){}disconnect(){closed=true}}
 const watch=watchToolbarEntry(doc,b=>bound.push(b),Observer);assert.equal(bound.length,0);
 const toolbar=new Element('div');toolbar.id='top-settings-holder';body.append(toolbar);const world=new Element('div');world.id='WI-SP-button';toolbar.append(world);
 callback();assert.equal(bound.length,1);assert.equal(toolbar.children[1].id,'dwm-toolbar-entry');assert.doesNotMatch(toolbar.children[1].className,/\bdrawer\b/);
 assert.match(bound[0].className,/\bdrawer-icon\b/);assert.match(bound[0].className,/\bclosedIcon\b/);assert.match(bound[0].className,/\bdrawerPinnedOpen\b/);
 let stopped=false;bound[0].listeners.keydown({key:'Enter',stopPropagation(){stopped=true}});assert.equal(stopped,true);
 callback();assert.equal(bound.length,1);toolbar.children[1].remove();callback();assert.equal(bound.length,2);
 watch.destroy();assert.equal(closed,true);assert.equal(doc.getElementById('dwm-toolbar-entry'),null);
});
