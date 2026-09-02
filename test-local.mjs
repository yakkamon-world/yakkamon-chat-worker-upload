import fs from 'node:fs';
// Offline smoke test: node test-local.mjs [path/to/chatbot-knowledge.json]
// Stubs docs.yakkamon.com and Anthropic so you can see which passages each question retrieves.
const kpath = process.argv[2] || '../yakkamonworld/chatbot-knowledge.json';
const knowledge = JSON.parse(fs.readFileSync(kpath,'utf8'));
// fake fetch: knowledge from disk, docs unavailable, anthropic stubbed
globalThis.fetch = async (url, opts) => {
  url = String(url);
  if (url.includes('chatbot-knowledge.json')) return new Response(JSON.stringify(knowledge), {status:200});
  if (url.includes('docs.yakkamon.com')) return new Response('nope', {status:403});
  if (url.includes('api.anthropic.com')) {
    const body = JSON.parse(opts.body);
    const user = body.messages[body.messages.length-1].content;
    globalThis.__lastPrompt = user;
    return new Response(JSON.stringify({content:[{type:'text', text: JSON.stringify({answer:'**14 September** on the Ronin Launchpad.', sources:['official','yw'], link:{title:'Free mint guide →', url:'https://yakkamonworld.com/article-ronin-free-mint-guide.html'}})}]}), {status:200});
  }
  throw new Error('unexpected fetch '+url);
};
const mod = await import('./index.js');
const env = { ANTHROPIC_API_KEY: 'test' };
const ctx = { waitUntil(){} };
async function ask(q, history=[]) {
  const req = new Request('https://x.workers.dev/chat', {method:'POST', headers:{'content-type':'application/json', Origin:'https://yakkamonworld.com'}, body: JSON.stringify({q, history})});
  const r = await mod.default.fetch(req, env, ctx);
  const j = await r.json();
  const prompt = globalThis.__lastPrompt || '';
  const titles = [...prompt.matchAll(/^\[([OSD]\d)\] (.*)$/gm)].map(m=>m[1]+' '+m[2].slice(0,90));
  console.log('\nQ:', q, '→', r.status, JSON.stringify(j).slice(0,120));
  console.log('  passages:', titles.length, 'prompt chars:', prompt.length); titles.forEach(t=>console.log('   ', t));
}
await ask('When is the free mint?');
await ask("What's this week's deposit multiplier?");
await ask('What does the Ghost legendary do?');
await ask('Do my monsters decay if I stop logging in?');
await ask('Is there a video about regions?');
await ask('How do referrals work now?');
const s = await mod.default.fetch(new Request('https://x.workers.dev/status'), env, ctx); console.log('\nstatus', await s.text());
const o = await mod.default.fetch(new Request('https://x.workers.dev/chat', {method:'OPTIONS', headers:{Origin:'https://evil.example'}}), env, ctx); console.log('preflight from evil origin → allow-origin:', o.headers.get('access-control-allow-origin'));
