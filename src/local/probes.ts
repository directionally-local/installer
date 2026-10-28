/**
 * Small checks run with this computer's own Node (always there: `dl` runs on it), so they
 * need no curl, lsof, or ss and behave the same on macOS and Linux.
 */
import type { System } from "../system.js";

/**
 * Exit 0 when HOST:PORT is free. Connecting first catches a listener on 0.0.0.0, which
 * macOS would still let us bind 127.0.0.1 next to.
 */
export const PORT_FREE_SCRIPT = [
  "const net=require('net');const [h,p]=[process.argv[1],Number(process.argv[2])];",
  "const c=net.connect(p,h);c.once('connect',()=>{c.destroy();process.exit(1)});",
  "c.once('error',()=>{const s=net.createServer();s.once('error',()=>process.exit(1));s.listen(p,h,()=>s.close(()=>process.exit(0)))});",
].join("");

/** Prints the HTTP status of GET URL (0 if nothing answers); a bearer token, if any, comes on stdin. */
export const HTTP_STATUS_SCRIPT = [
  "let t='';process.stdin.on('data',d=>t+=d).on('end',async()=>{",
  "try{const r=await fetch(process.argv[1],{headers:t.trim()?{authorization:'Bearer '+t.trim()}:{},signal:AbortSignal.timeout(5000)});",
  "console.log(r.status)}catch{console.log(0)}});",
].join("");

export async function portFree(system: System, node: string, host: string, port: number): Promise<boolean> {
  return (await system.probe(node, ["-e", PORT_FREE_SCRIPT, host, String(port)])).code === 0;
}

export async function httpStatus(system: System, node: string, url: string, token = ""): Promise<number> {
  const result = await system.probe(node, ["-e", HTTP_STATUS_SCRIPT, url], { input: token });
  return Number(result.stdout.trim()) || 0;
}
