const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jyolfcpplxqqcicvpesx.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp5b2xmY3BwbHhxcWNpY3ZwZXN4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMzMzk0NzQsImV4cCI6MjA4ODkxNTQ3NH0.aTwuAixgDwjdQ-rl_VciuoQrG-ALN1_YhsBrxuE-prc';
const JWT_SECRET = process.env.JWT_SECRET || 'cloudvault_secret_2024';
const ADMIN_KEY = process.env.ADMIN_KEY || 'minaz_admin_2024';
const ADMIN_TG_ID = process.env.ADMIN_TG_ID || '7670348638';
const NAGAD_NUMBER = process.env.BKASH_NUMBER || '01935926051';

const BOTS = [
  { token: process.env.BOT1_TOKEN || '8797865992:AAFAJ91XtzfeiWWlOQmPquqQeM7sonGNHH0', channel: process.env.CH1_ID || '-1003711197476' },
  { token: process.env.BOT2_TOKEN || '8517194817:AAGaSfslo45QnyvpeLt1HtPtsl6juAonMUg', channel: process.env.CH2_ID || '-1003705239320' },
];

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Store chunks in memory temporarily (for chunked upload assembly)
const chunkStore = new Map();

// Multer for chunk uploads (max 50MB per chunk)
const upload = multer({
  dest: '/tmp/',
  limits: { fileSize: 55 * 1024 * 1024 }
});

// ========== AUTH ==========
const auth = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
};

function genId(len = 16) {
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: len }, () => c[Math.floor(Math.random() * c.length)]).join('');
}

function genPassword(len = 14) {
  const c = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#$!';
  return Array.from({ length: len }, () => c[Math.floor(Math.random() * c.length)]).join('');
}

// ========== TELEGRAM UPLOAD ==========
async function uploadToTelegram(botToken, channelId, fileBuffer, fileName) {
  try {
    const form = new FormData();
    form.append('chat_id', channelId);
    form.append('document', fileBuffer, { filename: fileName });
    const res = await axios.post(
      `https://api.telegram.org/bot${botToken}/sendDocument`,
      form,
      { headers: form.getHeaders(), maxBodyLength: Infinity, timeout: 300000 }
    );
    if (res.data.ok) {
      return {
        success: true,
        fileId: res.data.result.document.file_id,
        msgId: res.data.result.message_id,
        channelId
      };
    }
    return { success: false };
  } catch (e) {
    console.error('TG upload error:', e.message);
    return { success: false };
  }
}

async function uploadToGoFile(fileBuffer, fileName) {
  try {
    const serverRes = await axios.get('https://api.gofile.io/servers', { timeout: 10000 });
    const server = serverRes.data.data.servers[0].name;
    const form = new FormData();
    form.append('file', fileBuffer, { filename: fileName });
    const res = await axios.post(`https://${server}.gofile.io/uploadFile`, form, {
      headers: form.getHeaders(), maxBodyLength: Infinity, timeout: 300000
    });
    if (res.data.status === 'ok') return { success: true, fileId: res.data.data.fileId, url: res.data.data.downloadPage };
    return { success: false };
  } catch { return { success: false }; }
}

// Get Telegram download URL
async function getTelegramFileUrl(botToken, fileId) {
  try {
    const res = await axios.get(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`, { timeout: 15000 });
    if (res.data.ok) {
      return `https://api.telegram.org/file/bot${botToken}/${res.data.result.file_path}`;
    }
    return null;
  } catch { return null; }
}

// ========== AUTH ROUTES ==========
app.post('/api/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'All fields required' });
    const { data: ex } = await supabase.from('users').select('id').eq('email', email).single();
    if (ex) return res.status(400).json({ error: 'Email already exists' });
    const hashed = await bcrypt.hash(password, 10);
    const userId = uuidv4();
    const { error } = await supabase.from('users').insert({
      id: userId, email, password: hashed, name,
      plan: 'free', storage_used: 0, storage_limit: 107374182400,
      created_at: new Date().toISOString()
    });
    if (error) throw error;
    const token = jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: userId, email, name, plan: 'free' } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ userId: user.id, email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, plan: user.plan, plan_expires_at: user.plan_expires_at } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/me', auth, async (req, res) => {
  try {
    const { data: user } = await supabase.from('users').select('id,email,name,plan,plan_expires_at,storage_used,storage_limit,created_at').eq('id', req.user.userId).single();
    res.json({ user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ========== CHUNK UPLOAD ==========
// Step 1: Initialize upload session
app.post('/api/upload/init', auth, async (req, res) => {
  try {
    const { fileName, fileSize, totalChunks, folderId } = req.body;
    if (!fileName || !folderId) return res.status(400).json({ error: 'Missing fields' });

    // Verify folder
    const { data: folder } = await supabase.from('folders').select('id').eq('id', folderId).eq('user_id', req.user.userId).single();
    if (!folder) return res.status(404).json({ error: 'Folder not found' });

    const uploadId = uuidv4();
    const fileId = genId(16);

    chunkStore.set(uploadId, {
      fileId, fileName, fileSize, totalChunks,
      folderId, userId: req.user.userId,
      chunks: new Array(totalChunks).fill(null),
      receivedChunks: 0,
      createdAt: Date.now()
    });

    // Cleanup old sessions after 2 hours
    setTimeout(() => chunkStore.delete(uploadId), 7200000);

    res.json({ uploadId, fileId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Step 2: Upload each chunk
app.post('/api/upload/chunk', auth, upload.single('chunk'), async (req, res) => {
  try {
    const { uploadId, chunkIndex } = req.body;
    const idx = parseInt(chunkIndex);

    if (!chunkStore.has(uploadId)) return res.status(404).json({ error: 'Upload session not found' });

    const session = chunkStore.get(uploadId);
    if (session.userId !== req.user.userId) return res.status(403).json({ error: 'Unauthorized' });

    // Read chunk file
    const chunkBuffer = fs.readFileSync(req.file.path);
    fs.unlinkSync(req.file.path);

    session.chunks[idx] = chunkBuffer;
    session.receivedChunks++;

    const progress = Math.round((session.receivedChunks / session.totalChunks) * 40);
    res.json({ received: session.receivedChunks, total: session.totalChunks, progress });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Step 3: Finalize - assemble and upload to Telegram
app.post('/api/upload/finalize', auth, async (req, res) => {
  const { uploadId } = req.body;

  if (!chunkStore.has(uploadId)) return res.status(404).json({ error: 'Upload session not found' });

  const session = chunkStore.get(uploadId);
  if (session.userId !== req.user.userId) return res.status(403).json({ error: 'Unauthorized' });

  // Check all chunks received
  if (session.receivedChunks !== session.totalChunks) {
    return res.status(400).json({ error: `Missing chunks: ${session.receivedChunks}/${session.totalChunks}` });
  }

  // SSE for progress
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const send = (msg, pct) => res.write(`data: ${JSON.stringify({ message: msg, percent: pct })}\n\n`);

  try {
    send('Assembling file...', 45);

    // Assemble file
    const fileBuffer = Buffer.concat(session.chunks);

    // Split into 1600MB pieces for Telegram
    const TG_LIMIT = 1600 * 1024 * 1024;
    const parts = [];
    let offset = 0;
    while (offset < fileBuffer.length) {
      parts.push(fileBuffer.slice(offset, offset + TG_LIMIT));
      offset += TG_LIMIT;
    }

    send(`Uploading ${parts.length} part(s) to storage...`, 50);

    const chunkResults = [];
    for (let i = 0; i < parts.length; i++) {
      const partName = parts.length > 1
        ? `${session.fileId}_p${i + 1}of${parts.length}_${session.fileName}`
        : `${session.fileId}_${session.fileName}`;

      const pct = 50 + Math.round((i / parts.length) * 40);
      send(`Uploading part ${i + 1}/${parts.length}...`, pct);

      // Upload to both Telegram bots + GoFile
      const [tg1, tg2, gf] = await Promise.all([
        uploadToTelegram(BOTS[0].token, BOTS[0].channel, parts[i], partName),
        uploadToTelegram(BOTS[1].token, BOTS[1].channel, parts[i], partName),
        uploadToGoFile(parts[i], partName),
      ]);

      chunkResults.push({
        index: i,
        fileName: partName,
        size: parts[i].length,
        telegram: [
          tg1.success ? { botIndex: 0, fileId: tg1.fileId, msgId: tg1.msgId, channelId: BOTS[0].channel, token: BOTS[0].token } : null,
          tg2.success ? { botIndex: 1, fileId: tg2.fileId, msgId: tg2.msgId, channelId: BOTS[1].channel, token: BOTS[1].token } : null,
        ].filter(Boolean),
        gofile: gf.success ? gf : null,
      });
    }

    send('Saving to database...', 93);

    const { error: dbErr } = await supabase.from('files').insert({
      id: session.fileId,
      user_id: session.userId,
      folder_id: session.folderId,
      original_name: session.fileName,
      size: fileBuffer.length,
      total_chunks: parts.length,
      chunks: JSON.stringify(chunkResults),
      download_count: 0,
      created_at: new Date().toISOString()
    });
    if (dbErr) throw dbErr;

    await supabase.rpc('increment_storage', { p_user_id: session.userId, bytes: fileBuffer.length });

    chunkStore.delete(uploadId);

    send('Done!', 100);
    res.write(`data: ${JSON.stringify({ done: true, fileId: session.fileId, fileName: session.fileName })}\n\n`);
    res.end();
  } catch (e) {
    chunkStore.delete(uploadId);
    try { res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`); res.end(); } catch {}
  }
});

// ========== DOWNLOAD PROXY ==========
// This downloads the file from Telegram and streams it to user
// User never sees Telegram URLs
app.get('/api/file/:fileId', async (req, res) => {
  try {
    const { password } = req.query;
    const { data: file } = await supabase.from('files').select('*').eq('id', req.params.fileId).single();
    if (!file) return res.status(404).json({ error: 'File not found' });

    // Verify folder password
    const { data: folder } = await supabase.from('folders').select('password_hash').eq('id', file.folder_id).single();
    if (folder?.password_hash) {
      if (!password) return res.status(403).json({ error: 'Password required', needPassword: true });
      const valid = await bcrypt.compare(password, folder.password_hash);
      if (!valid) return res.status(403).json({ error: 'Wrong password' });
    }

    const chunks = JSON.parse(file.chunks);

    if (chunks.length === 1) {
      // Single file - stream directly
      const chunk = chunks[0];
      const tg = chunk.telegram?.[0];
      if (tg) {
        const url = await getTelegramFileUrl(BOTS[tg.botIndex]?.token || BOTS[0].token, tg.fileId);
        if (url) {
          const fileRes = await axios.get(url, { responseType: 'stream', timeout: 300000 });
          res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.original_name)}"`);
          res.setHeader('Content-Type', 'application/octet-stream');
          if (file.size) res.setHeader('Content-Length', file.size);
          fileRes.data.pipe(res);
          await supabase.from('files').update({ download_count: (file.download_count || 0) + 1 }).eq('id', req.params.fileId);
          return;
        }
      }
      // Fallback to GoFile
      if (chunk.gofile?.url) {
        return res.redirect(chunk.gofile.url);
      }
    } else {
      // Multi-part: return info for client to handle
      const partLinks = chunks.map((chunk, i) => ({
        part: i + 1,
        fileName: chunk.fileName,
        size: chunk.size,
        downloadUrl: `/api/file/${req.params.fileId}/part/${i}?password=${encodeURIComponent(password || '')}`
      }));
      return res.json({
        multiPart: true,
        totalParts: chunks.length,
        fileName: file.original_name,
        parts: partLinks
      });
    }

    res.status(500).json({ error: 'No download source available' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Download specific part
app.get('/api/file/:fileId/part/:partIndex', async (req, res) => {
  try {
    const { password } = req.query;
    const partIdx = parseInt(req.params.partIndex);

    const { data: file } = await supabase.from('files').select('*').eq('id', req.params.fileId).single();
    if (!file) return res.status(404).json({ error: 'File not found' });

    const { data: folder } = await supabase.from('folders').select('password_hash').eq('id', file.folder_id).single();
    if (folder?.password_hash) {
      if (!password) return res.status(403).json({ error: 'Password required' });
      const valid = await bcrypt.compare(password, folder.password_hash);
      if (!valid) return res.status(403).json({ error: 'Wrong password' });
    }

    const chunks = JSON.parse(file.chunks);
    const chunk = chunks[partIdx];
    if (!chunk) return res.status(404).json({ error: 'Part not found' });

    const tg = chunk.telegram?.[0];
    if (tg) {
      const botToken = BOTS[tg.botIndex]?.token || BOTS[0].token;
      const url = await getTelegramFileUrl(botToken, tg.fileId);
      if (url) {
        const fileRes = await axios.get(url, { responseType: 'stream', timeout: 300000 });
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(chunk.fileName)}"`);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', chunk.size);
        fileRes.data.pipe(res);
        return;
      }
    }
    if (chunk.gofile?.url) return res.redirect(chunk.gofile.url);
    res.status(500).json({ error: 'No source available' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ========== FOLDERS ==========
app.get('/api/folders', auth, async (req, res) => {
  try {
    const parentId = req.query.parent_id || null;
    let query = supabase.from('folders').select('id,name,parent_id,created_at').eq('user_id', req.user.userId);
    if (parentId) query = query.eq('parent_id', parentId);
    else query = query.is('parent_id', null);
    const { data, error } = await query.order('name');
    if (error) throw error;
    res.json({ folders: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/folders', auth, async (req, res) => {
  try {
    const { name, parent_id } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const folderId = genId(12);
    const rawPw = genPassword(14);
    const pwHash = await bcrypt.hash(rawPw, 10);
    const { error } = await supabase.from('folders').insert({
      id: folderId, user_id: req.user.userId,
      parent_id: parent_id || null, name,
      password_hash: pwHash, created_at: new Date().toISOString()
    });
    if (error) throw error;
    res.json({ folder: { id: folderId, name, parent_id: parent_id || null }, password: rawPw });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/folders/:id', auth, async (req, res) => {
  try {
    const { name } = req.body;
    const { data: f } = await supabase.from('folders').select('id').eq('id', req.params.id).eq('user_id', req.user.userId).single();
    if (!f) return res.status(404).json({ error: 'Not found' });
    await supabase.from('folders').update({ name }).eq('id', req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/folders/:id', auth, async (req, res) => {
  try {
    const { data: f } = await supabase.from('folders').select('id').eq('id', req.params.id).eq('user_id', req.user.userId).single();
    if (!f) return res.status(404).json({ error: 'Not found' });
    await supabase.from('folders').delete().eq('id', req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/folders/:id/verify', auth, async (req, res) => {
  try {
    const { password } = req.body;
    const { data: f } = await supabase.from('folders').select('password_hash').eq('id', req.params.id).eq('user_id', req.user.userId).single();
    if (!f) return res.status(404).json({ error: 'Not found' });
    const valid = await bcrypt.compare(password, f.password_hash);
    res.json({ valid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ========== FILES ==========
app.get('/api/files', auth, async (req, res) => {
  try {
    const { folder_id } = req.query;
    if (!folder_id) return res.status(400).json({ error: 'folder_id required' });
    const { data, error } = await supabase.from('files')
      .select('id,original_name,size,total_chunks,download_count,created_at')
      .eq('user_id', req.user.userId).eq('folder_id', folder_id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ files: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/files/:id', auth, async (req, res) => {
  try {
    const { data: f } = await supabase.from('files').select('id,size').eq('id', req.params.id).eq('user_id', req.user.userId).single();
    if (!f) return res.status(404).json({ error: 'Not found' });
    await supabase.from('files').delete().eq('id', req.params.id);
    await supabase.rpc('increment_storage', { p_user_id: req.user.userId, bytes: -(f.size) });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ========== PAYMENT ==========
app.post('/api/payment', auth, async (req, res) => {
  try {
    const { transactionId, nagadNumber, amount, storageTb, months } = req.body;
    if (!transactionId || !nagadNumber) return res.status(400).json({ error: 'All fields required' });
    const { data: ex } = await supabase.from('payments').select('id').eq('transaction_id', transactionId).single();
    if (ex) return res.status(400).json({ error: 'Transaction ID already used' });
    const { data: user } = await supabase.from('users').select('email,name').eq('id', req.user.userId).single();
    await supabase.from('payments').insert({
      user_id: req.user.userId, transaction_id: transactionId,
      amount: parseFloat(amount), bkash_number: nagadNumber,
      storage_tb: parseInt(storageTb) || 1, months: parseInt(months) || 6,
      status: 'pending', created_at: new Date().toISOString()
    });
    const msg = `💳 নতুন Payment!\n\nUser: ${user?.name} (${user?.email})\nTxn ID: ${transactionId}\nAmount: ৳${amount}\nNagad: ${nagadNumber}\nStorage: ${storageTb}TB × ${months} মাস\n\nApprove করুন admin panel থেকে`;
    await axios.post(`https://api.telegram.org/bot${BOTS[0].token}/sendMessage`, { chat_id: ADMIN_TG_ID, text: msg }).catch(() => {});
    res.json({ success: true, message: 'Payment submitted! ১ ঘণ্টার মধ্যে activate হবে।' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ========== ADMIN ==========
app.get('/api/admin/payments', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  const { data } = await supabase.from('payments').select('*').order('created_at', { ascending: false });
  res.json({ payments: data || [] });
});

app.post('/api/admin/approve', async (req, res) => {
  if (req.body.key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  const { transactionId } = req.body;
  const { data: payment } = await supabase.from('payments').select('*').eq('transaction_id', transactionId).single();
  if (!payment) return res.status(404).json({ error: 'Not found' });
  const bytes = payment.storage_tb * 1099511627776;
  const expires = new Date();
  expires.setMonth(expires.getMonth() + payment.months);
  await supabase.from('payments').update({ status: 'approved' }).eq('id', payment.id);
  await supabase.from('users').update({ plan: `${payment.storage_tb}TB`, plan_expires_at: expires.toISOString(), storage_limit: bytes }).eq('id', payment.user_id);
  res.json({ success: true });
});

app.get('/api/admin/users', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  const { data } = await supabase.from('users').select('id,email,name,plan,plan_expires_at,storage_used,storage_limit,created_at').order('created_at', { ascending: false });
  res.json({ users: data || [] });
});

app.get('/api/config', (req, res) => res.json({ nagadNumber: NAGAD_NUMBER }));
app.get('/', (req, res) => res.json({ status: 'CloudVault API ✅', version: '2.0' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`CloudVault API v2 on port ${PORT}`));
