const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const JSZip = require('jszip');

const app = express();
app.use(cors());
app.use(express.json());

// ========== CONFIG ==========
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jyolfcpplxqqcicvpesx.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp5b2xmY3BwbHhxcWNpY3ZwZXN4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMzMzk0NzQsImV4cCI6MjA4ODkxNTQ3NH0.aTwuAixgDwjdQ-rl_VciuoQrG-ALN1_YhsBrxuE-prc';
const JWT_SECRET = process.env.JWT_SECRET || 'cloudvault_minaz_2024_secret';
const ADMIN_KEY = process.env.ADMIN_KEY || 'minaz_admin_2024';
const ADMIN_TG_ID = process.env.ADMIN_TG_ID || '7670348638';
const BKASH_NUMBER = process.env.BKASH_NUMBER || '01XXXXXXXXX';
const CHUNK_SIZE = 1600 * 1024 * 1024;

const TELEGRAM_BOTS = [
  { token: process.env.BOT1_TOKEN || '8797865992:AAFAJ91XtzfeiWWlOQmPquqQeM7sonGNHH0', channel: process.env.CH1_ID || '-1003711197476' },
  { token: process.env.BOT2_TOKEN || '8517194817:AAGaSfslo45QnyvpeLt1HtPtsl6juAonMUg', channel: process.env.CH2_ID || '-1003705239320' },
];

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const upload = multer({ dest: '/tmp/', limits: { fileSize: 50 * 1024 * 1024 * 1024 } });

// ========== AUTH MIDDLEWARE ==========
const auth = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// ========== HELPERS ==========
function generateId(len = 16) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < len; i++) result += chars[Math.floor(Math.random() * chars.length)];
  return result;
}

function generatePassword(len = 14) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#$!';
  let result = '';
  for (let i = 0; i < len; i++) result += chars[Math.floor(Math.random() * chars.length)];
  return result;
}

function splitBuffer(buffer, chunkSize) {
  const chunks = [];
  let offset = 0;
  while (offset < buffer.length) {
    chunks.push(buffer.slice(offset, offset + chunkSize));
    offset += chunkSize;
  }
  return chunks;
}

async function uploadToTelegram(botToken, channelId, fileBuffer, fileName) {
  try {
    const form = new FormData();
    form.append('chat_id', channelId);
    form.append('document', fileBuffer, { filename: fileName });
    const response = await axios.post(
      `https://api.telegram.org/bot${botToken}/sendDocument`,
      form, { headers: form.getHeaders(), maxBodyLength: Infinity, timeout: 600000 }
    );
    if (response.data.ok) {
      return { success: true, fileId: response.data.result.document.file_id, msgId: response.data.result.message_id };
    }
    return { success: false };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function uploadToPixeldrain(fileBuffer, fileName) {
  try {
    const form = new FormData();
    form.append('file', fileBuffer, { filename: fileName });
    const response = await axios.post('https://pixeldrain.com/api/file', form, {
      headers: form.getHeaders(), maxBodyLength: Infinity, timeout: 600000
    });
    if (response.data.id) return { success: true, id: response.data.id, url: `https://pixeldrain.com/u/${response.data.id}` };
    return { success: false };
  } catch (err) {
    return { success: false };
  }
}

async function uploadToGoFile(fileBuffer, fileName) {
  try {
    const serverRes = await axios.get('https://api.gofile.io/servers');
    const server = serverRes.data.data.servers[0].name;
    const form = new FormData();
    form.append('file', fileBuffer, { filename: fileName });
    const response = await axios.post(`https://${server}.gofile.io/uploadFile`, form, {
      headers: form.getHeaders(), maxBodyLength: Infinity, timeout: 600000
    });
    if (response.data.status === 'ok') return { success: true, url: response.data.data.downloadPage, fileId: response.data.data.fileId };
    return { success: false };
  } catch (err) {
    return { success: false };
  }
}

// ========== AUTH ROUTES ==========
app.post('/api/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'All fields required' });

    const { data: existing } = await supabase.from('users').select('id').eq('email', email).single();
    if (existing) return res.status(400).json({ error: 'Email already exists' });

    const hashed = await bcrypt.hash(password, 10);
    const userId = uuidv4();

    const { error } = await supabase.from('users').insert({
      id: userId, email, password: hashed, name,
      plan: 'free', storage_used: 0, created_at: new Date().toISOString()
    });
    if (error) throw error;

    const token = jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: userId, email, name, plan: 'free' } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    const token = jwt.sign({ userId: user.id, email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, plan: user.plan, plan_expires_at: user.plan_expires_at } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/me', auth, async (req, res) => {
  try {
    const { data: user } = await supabase.from('users').select('id,email,name,plan,plan_expires_at,storage_used,storage_limit,created_at').eq('id', req.user.userId).single();
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== FOLDER ROUTES ==========
app.get('/api/folders', auth, async (req, res) => {
  try {
    const parentId = req.query.parent_id || null;
    const { data, error } = await supabase.from('folders')
      .select('id,name,parent_id,created_at')
      .eq('user_id', req.user.userId)
      .is('parent_id', parentId ? undefined : null)
      .eq(parentId ? 'parent_id' : 'id', parentId || 'id');

    // Fix query based on parent_id
    let query = supabase.from('folders').select('id,name,parent_id,created_at').eq('user_id', req.user.userId);
    if (parentId) query = query.eq('parent_id', parentId);
    else query = query.is('parent_id', null);

    const { data: folders, error: err } = await query.order('created_at', { ascending: false });
    if (err) throw err;
    res.json({ folders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/folders', auth, async (req, res) => {
  try {
    const { name, parent_id } = req.body;
    if (!name) return res.status(400).json({ error: 'Folder name required' });

    const folderId = generateId(12);
    const rawPassword = generatePassword(14);
    const passwordHash = await bcrypt.hash(rawPassword, 10);

    const { error } = await supabase.from('folders').insert({
      id: folderId,
      user_id: req.user.userId,
      parent_id: parent_id || null,
      name,
      password_hash: passwordHash,
      created_at: new Date().toISOString()
    });
    if (error) throw error;

    res.json({ folder: { id: folderId, name, parent_id: parent_id || null }, password: rawPassword });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/folders/:id', auth, async (req, res) => {
  try {
    const { data: folder } = await supabase.from('folders').select('id').eq('id', req.params.id).eq('user_id', req.user.userId).single();
    if (!folder) return res.status(404).json({ error: 'Folder not found' });
    await supabase.from('folders').delete().eq('id', req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verify folder password
app.post('/api/folders/:id/verify', auth, async (req, res) => {
  try {
    const { password } = req.body;
    const { data: folder } = await supabase.from('folders').select('password_hash').eq('id', req.params.id).eq('user_id', req.user.userId).single();
    if (!folder) return res.status(404).json({ error: 'Folder not found' });

    const valid = await bcrypt.compare(password, folder.password_hash);
    res.json({ valid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== FILE ROUTES ==========
app.get('/api/files', auth, async (req, res) => {
  try {
    const folderId = req.query.folder_id;
    if (!folderId) return res.status(400).json({ error: 'folder_id required' });

    const { data: files, error } = await supabase.from('files')
      .select('id,original_name,size,total_chunks,download_count,created_at')
      .eq('user_id', req.user.userId)
      .eq('folder_id', folderId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/upload', auth, upload.single('file'), async (req, res) => {
  const tempFiles = [];
  try {
    const { folder_id } = req.body;
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file' });
    if (!folder_id) return res.status(400).json({ error: 'folder_id required' });

    // Verify folder belongs to user
    const { data: folder } = await supabase.from('folders').select('id,password_hash').eq('id', folder_id).eq('user_id', req.user.userId).single();
    if (!folder) return res.status(404).json({ error: 'Folder not found' });

    const fileId = generateId(16);
    const originalName = file.originalname;
    tempFiles.push(file.path);

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

    const send = (msg, percent) => res.write(`data: ${JSON.stringify({ message: msg, percent })}\n\n`);

    send('Reading file...', 5);
    let fileBuffer = fs.readFileSync(file.path);

    // ZIP the file
    send('Creating ZIP...', 15);
    const zip = new JSZip();
    zip.file(originalName, fileBuffer);
    fileBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const finalName = originalName + '.zip';

    // Split
    const chunks = splitBuffer(fileBuffer, CHUNK_SIZE);
    send(`Splitting into ${chunks.length} part(s)...`, 25);

    const chunkResults = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunkName = chunks.length > 1 ? `${fileId}_p${i + 1}of${chunks.length}.zip` : `${fileId}.zip`;
      const progressBase = 30 + (i / chunks.length) * 60;
      send(`Uploading part ${i + 1}/${chunks.length}...`, progressBase);

      const [tg1, tg2, pd, gf] = await Promise.all([
        uploadToTelegram(TELEGRAM_BOTS[0].token, TELEGRAM_BOTS[0].channel, chunks[i], chunkName),
        uploadToTelegram(TELEGRAM_BOTS[1].token, TELEGRAM_BOTS[1].channel, chunks[i], chunkName),
        uploadToPixeldrain(chunks[i], chunkName),
        uploadToGoFile(chunks[i], chunkName),
      ]);

      chunkResults.push({
        index: i, fileName: chunkName, size: chunks[i].length,
        telegram: [
          tg1.success ? { botIndex: 0, fileId: tg1.fileId, msgId: tg1.msgId, channelId: TELEGRAM_BOTS[0].channel } : null,
          tg2.success ? { botIndex: 1, fileId: tg2.fileId, msgId: tg2.msgId, channelId: TELEGRAM_BOTS[1].channel } : null,
        ].filter(Boolean),
        pixeldrain: pd.success ? pd : null,
        gofile: gf.success ? gf : null,
      });
    }

    send('Saving...', 93);

    const { error: dbError } = await supabase.from('files').insert({
      id: fileId,
      user_id: req.user.userId,
      folder_id,
      original_name: originalName,
      size: fileBuffer.length,
      total_chunks: chunks.length,
      chunks: JSON.stringify(chunkResults),
      download_count: 0,
      created_at: new Date().toISOString()
    });
    if (dbError) throw dbError;

    await supabase.rpc('increment_storage', { p_user_id: req.user.userId, bytes: fileBuffer.length });

    send('Done!', 100);
    res.write(`data: ${JSON.stringify({ done: true, fileId, fileName: originalName, size: fileBuffer.length, chunks: chunks.length })}\n\n`);
    res.end();
  } catch (err) {
    try { res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`); res.end(); } catch {}
  } finally {
    tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch {} });
  }
});

app.delete('/api/files/:id', auth, async (req, res) => {
  try {
    const { data: file } = await supabase.from('files').select('id,size').eq('id', req.params.id).eq('user_id', req.user.userId).single();
    if (!file) return res.status(404).json({ error: 'File not found' });
    await supabase.from('files').delete().eq('id', req.params.id);
    await supabase.rpc('increment_storage', { p_user_id: req.user.userId, bytes: -(file.size) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== DOWNLOAD ==========
app.get('/api/download/:fileId', async (req, res) => {
  try {
    const { password } = req.query;
    const { data: file } = await supabase.from('files').select('*').eq('id', req.params.fileId).single();
    if (!file) return res.status(404).json({ error: 'File not found' });

    // Verify folder password
    const { data: folder } = await supabase.from('folders').select('password_hash').eq('id', file.folder_id).single();
    if (folder && folder.password_hash) {
      if (!password) return res.status(403).json({ error: 'Password required', needPassword: true });
      const valid = await bcrypt.compare(password, folder.password_hash);
      if (!valid) return res.status(403).json({ error: 'Wrong password' });
    }

    const chunks = JSON.parse(file.chunks);
    const downloadLinks = chunks.map((chunk, i) => {
      const links = [];
      chunk.telegram?.forEach(tg => {
        if (tg?.channelId && tg?.msgId) {
          const ch = tg.channelId.toString().replace('-100', '');
          links.push({ source: `Telegram ${tg.botIndex + 1}`, type: 'telegram', url: `https://t.me/c/${ch}/${tg.msgId}` });
        }
      });
      if (chunk.pixeldrain?.id) links.push({ source: 'Pixeldrain', type: 'direct', url: `https://pixeldrain.com/api/file/${chunk.pixeldrain.id}?download` });
      if (chunk.gofile?.url) links.push({ source: 'GoFile', type: 'direct', url: chunk.gofile.url });
      return { part: i + 1, fileName: chunk.fileName, size: chunk.size, links };
    });

    await supabase.from('files').update({ download_count: (file.download_count || 0) + 1 }).eq('id', req.params.fileId);

    res.json({ fileId: file.id, originalName: file.original_name, size: file.size, totalChunks: file.total_chunks, downloadLinks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== PAYMENT ==========
app.post('/api/payment', auth, async (req, res) => {
  try {
    const { transactionId, bkashNumber, amount, storageTb, months } = req.body;
    if (!transactionId || !bkashNumber) return res.status(400).json({ error: 'All fields required' });

    const { data: existing } = await supabase.from('payments').select('id').eq('transaction_id', transactionId).single();
    if (existing) return res.status(400).json({ error: 'Transaction ID already used' });

    const { data: user } = await supabase.from('users').select('email,name').eq('id', req.user.userId).single();

    await supabase.from('payments').insert({
      user_id: req.user.userId,
      transaction_id: transactionId,
      amount: parseFloat(amount),
      bkash_number: bkashNumber,
      storage_tb: parseInt(storageTb) || 1,
      months: parseInt(months) || 6,
      status: 'pending',
      created_at: new Date().toISOString()
    });

    // Notify admin
    const msg = `💳 নতুন Payment!\n\nUser: ${user?.name} (${user?.email})\nTxn ID: ${transactionId}\nAmount: ৳${amount}\nbKash: ${bkashNumber}\nStorage: ${storageTb}TB × ${months} months\n\nApprove করতে:\n/approve ${transactionId}`;
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOTS[0].token}/sendMessage`, { chat_id: ADMIN_TG_ID, text: msg }).catch(() => {});

    res.json({ success: true, message: 'Payment submitted! ১ ঘণ্টার মধ্যে activate হবে।' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== ADMIN ==========
app.get('/api/admin/payments', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  const { data } = await supabase.from('payments').select('*').eq('status', 'pending').order('created_at', { ascending: false });
  res.json({ payments: data });
});

app.post('/api/admin/approve', async (req, res) => {
  if (req.body.key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  const { transactionId } = req.body;

  const { data: payment } = await supabase.from('payments').select('*').eq('transaction_id', transactionId).single();
  if (!payment) return res.status(404).json({ error: 'Payment not found' });

  const storageBytes = payment.storage_tb * 1024 * 1024 * 1024 * 1024;
  const expiresAt = new Date();
  expiresAt.setMonth(expiresAt.getMonth() + payment.months);

  await supabase.from('payments').update({ status: 'approved' }).eq('id', payment.id);
  await supabase.from('users').update({
    plan: `${payment.storage_tb}TB`,
    plan_expires_at: expiresAt.toISOString(),
    storage_limit: storageBytes
  }).eq('id', payment.user_id);

  // Notify user via telegram if possible
  const { data: user } = await supabase.from('users').select('email').eq('id', payment.user_id).single();

  res.json({ success: true, message: `Approved for ${user?.email}` });
});

app.get('/api/config', (req, res) => {
  res.json({ bkashNumber: BKASH_NUMBER });
});

app.get('/', (req, res) => res.json({ status: 'CloudVault API Running ✅' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`CloudVault API on port ${PORT}`));
