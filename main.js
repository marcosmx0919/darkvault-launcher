const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { Client, Authenticator } = require('minecraft-launcher-core');
const { createClient } = require('@supabase/supabase-js');
const { Auth } = require('msmc');
const fs = require('fs');
const cfg = require('./config.json');

const sb = createClient(cfg.supabaseUrl, cfg.supabaseKey, { auth: { persistSession: false } });
const root = path.join(app.getPath('appData'), '.darkvault');
let win, ms = null, session = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1000, height: 650, minWidth: 840, minHeight: 580, backgroundColor: '#000000',
    title: 'DarkVault Launcher', icon: path.join(__dirname, 'build', 'icon.png'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  win.loadFile('index.html');
}
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

const prof = async () => {
  const { data } = await sb.from('profiles').select('username,mc_nick,skin_url,skin_model,is_admin,nick_changed_at').eq('id', session.user.id).maybeSingle();
  return data;
};

// Cuenta de la página web (la misma de DarkVault)
ipcMain.handle('auth', async (_, { mode, email, password }) => {
  const r = mode === 'reg' ? await sb.auth.signUp({ email, password }) : await sb.auth.signInWithPassword({ email, password });
  if (r.error) return { error: r.error.message };
  if (!r.data.session) return { error: 'Revisa tu correo para confirmar la cuenta y luego inicia sesión.' };
  session = r.data.session;
  return { profile: await prof(), email };
});

ipcMain.handle('versions', async () => {
  const j = await (await fetch('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json')).json();
  return j.versions.map(v => ({ id: v.id, type: v.type }));
});

// Cuenta Microsoft (premium, oficial)
ipcMain.handle('microsoft', async () => {
  try {
    const x = await new Auth('select_account').launch('electron');
    ms = await x.getMinecraft();
    return { name: ms.profile.name };
  } catch (e) { return { error: 'No se pudo iniciar sesión con Microsoft.' }; }
});

ipcMain.handle('play', async (_, { version, type, mode, ram, fabric }) => {
  if (!session) return { error: 'Inicia sesión con tu cuenta DarkVault.' };
  let authorization, features = [];
  if (mode === 'premium') {
    if (!ms) return { error: 'Primero inicia sesión con Microsoft.' };
    authorization = ms.mclc();
  } else { // Modo demo oficial de Minecraft (gratis, limitado por el propio juego)
    const p = await prof();
    authorization = Authenticator.getAuth((p?.mc_nick || 'Player').slice(0, 16));
    features = ['is_demo_user'];
  }
  let custom;
  try { if (fabric) custom = await fabricProfile(version); } catch (e) { return { error: String(e.message || e) }; }
  const launcher = new Client();
  launcher.on('progress', e => win.webContents.send('log', { total: e.total, task: e.task, kind: e.type }));
  launcher.on('debug', d => win.webContents.send('log', { text: String(d) }));
  launcher.on('close', () => win.webContents.send('closed'));
  try {
    await launcher.launch({ authorization, root, features, version: { number: version, type: type || 'release', ...(custom ? { custom } : {}) }, memory: { max: ram + 'G', min: '1G' } });
    return { ok: true };
  } catch (e) { return { error: String(e.message || e) }; }
});

// Skin de la página web -> la trae para mostrarla o aplicarla
ipcMain.handle('webskin', async () => {
  const p = await prof();
  if (!p?.skin_url) return { error: 'Aún no subes una skin en tu perfil de la página.' };
  const buf = Buffer.from(await (await fetch(p.skin_url)).arrayBuffer());
  return { data: buf.toString('base64'), model: p.skin_model || 'classic' };
});

// Cambiar skin de la cuenta Microsoft (API oficial de Mojang)
ipcMain.handle('skin', async (_, { data, model }) => {
  if (!ms) return { error: 'Cambiar la skin en el juego requiere cuenta Microsoft.' };
  const fd = new FormData();
  fd.append('variant', model === 'slim' ? 'slim' : 'classic');
  fd.append('file', new Blob([Buffer.from(data, 'base64')], { type: 'image/png' }), 'skin.png');
  const r = await fetch('https://api.minecraftservices.com/minecraft/profile/skins', {
    method: 'POST', headers: { Authorization: 'Bearer ' + ms.mclc().access_token }, body: fd
  });
  return r.ok ? { ok: true } : { error: 'Mojang rechazó la skin (' + r.status + ').' };
});

ipcMain.handle('site', () => shell.openExternal(cfg.siteUrl));

// ---- Fabric (necesario para mods y shaders) ----
async function fabricProfile(gv) {
  const L = await (await fetch(`https://meta.fabricmc.net/v2/versions/loader/${gv}`)).json();
  if (!L.length) throw new Error('Fabric no soporta la versión ' + gv);
  const lv = (L.find(x => x.loader.stable) || L[0]).loader.version;
  const j = await (await fetch(`https://meta.fabricmc.net/v2/versions/loader/${gv}/${lv}/profile/json`)).json();
  const d = path.join(root, 'versions', j.id); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, j.id + '.json'), JSON.stringify(j));
  return j.id;
}

// ---- Mods, shaders y paquetes de recursos (Modrinth, gratis) ----
const UA = { 'User-Agent': 'DarkVaultLauncher/0.2 (darkvault.pages.dev)' };
const DIR = { mod: 'mods', shader: 'shaderpacks', resourcepack: 'resourcepacks' };
const mr = async u => { const r = await fetch('https://api.modrinth.com/v2' + u, { headers: UA }); if (!r.ok) throw new Error('Modrinth ' + r.status); return r.json(); };

ipcMain.handle('search', async (_, { type, q, version }) => {
  try {
    const f = [[`project_type:${type}`], [`versions:${version}`]];
    if (type === 'mod') f.push(['categories:fabric']);
    const j = await mr(`/search?query=${encodeURIComponent(q || '')}&limit=15&index=downloads&facets=${encodeURIComponent(JSON.stringify(f))}`);
    return j.hits.map(h => ({ id: h.project_id, title: h.title, desc: h.description, icon: h.icon_url, type }));
  } catch (e) { return { error: e.message }; }
});

async function installProject(id, type, version, seen = new Set()) {
  if (seen.has(id)) return; seen.add(id);
  let u = `/project/${id}/version?game_versions=${encodeURIComponent(JSON.stringify([version]))}`;
  if (type === 'mod') u += `&loaders=${encodeURIComponent(JSON.stringify(['fabric']))}`;
  const vs = await mr(u);
  if (!vs.length) throw new Error('No hay versión compatible con ' + version);
  const v = vs[0], file = v.files.find(x => x.primary) || v.files[0];
  const dir = path.join(root, DIR[type]); fs.mkdirSync(dir, { recursive: true });
  const buf = Buffer.from(await (await fetch(file.url, { headers: UA })).arrayBuffer());
  fs.writeFileSync(path.join(dir, path.basename(file.filename)), buf);
  for (const d of v.dependencies || []) if (d.dependency_type === 'required' && d.project_id) await installProject(d.project_id, 'mod', version, seen);
}
ipcMain.handle('install', async (_, { id, type, version }) => {
  try { if (type === 'shader') await installProject('iris', 'mod', version); await installProject(id, type, version); return { ok: true }; }
  catch (e) { return { error: e.message }; }
});

// ---- Nick de Minecraft (1 cambio cada 30 días, lo controla la base de datos) ----
ipcMain.handle('nick', async (_, { nick }) => {
  if (!session) return { error: 'Inicia sesión primero.' };
  if (!/^[A-Za-z0-9_]{3,16}$/.test(nick)) return { error: 'Nick: 3 a 16 letras, números o _' };
  const { error } = await sb.from('profiles').update({ mc_nick: nick }).eq('id', session.user.id);
  return error ? { error: error.message } : { profile: await prof() };
});
