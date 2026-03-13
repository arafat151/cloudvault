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

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'cloudvault_secret_2024';
const ADMIN_KEY = process.env.ADMIN_KEY || 'minaz_admin_2024';
const ADMIN_TG_ID = process.env.ADMIN_TG_ID || '7670348638';
const NAGAD_NUMBER = process.env.BKASH_NUMBER || '01935926051';

const BOTS = [
  { token: process.env.BOT1_TOKEN, channel: process.env.CH1_ID },
  { token: process.env.BOT2_TOKEN, channel: process.env.CH2_ID },
];

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Multer — save to /tmp, max 20MB per chunk
const upload = multer({
  dest: '/tmp/cv_chunks/',
  limits: { fileSize: 20 * 1024 * 1024 }
});

// Ensure tmp dir exists
if (!fs.existsSync('/tmp/cv_chunks/')) fs.mkdirSync('/tmp/cv_chunks/', { recursive: true });

// ========== AUTH MIDDLEWARE ==========
const auth = (req, res, next) => {
  const t = req.headers.authorization?.replace('Bearer ', '');
  if (!t) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(t, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
};

function genPassword(len = 14) {
  const c = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#$!';
  return Array.from({ length: len }, () => c[Math.floor(Math.random() * c.length)]).join('');
}

// ========== TELEGRAM HELPERS ==========
async function sendChunkToTelegram(botToken, channelId, fileBuffer, fileName) {
  const form = new FormData();
  form.append('chat_id', channelId);
  form.append('document', fileBuffer, { filename: fileName, knownLength: fileBuffer.length });
  const res = await axios.post(
    `https://api.telegram.org/bot${botToken}/sendDocument`,
    form,
    { headers: form.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 120000 }
  );
  if (res.data.ok) return { fileId: res.data.result.document.file_id, msgId: res.data.result.message_id };
  throw new Error('Telegram upload failed');
}

async function getTgFileUrl(botToken, fileId) {
  const res = await axios.get(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`, { timeout: 10000 });
  if (res.data.ok) return `https://api.telegram.org/file/bot${botToken}/${res.data.result.file_path}`;
  return null;
}

async function uploadToGoFile(buffer, fileName) {
  try {
    const srv = await axios.get('https://api.gofile.io/servers', { timeout: 8000 });
    const server = srv.data.data.servers[0].name;
    const form = new FormData();
    form.append('file', buffer, { filename: fileName });
    const res = await axios.post(`https://${server}.gofile.io/uploadFile`, form, {
      headers: form.getHeaders(), maxBodyLength: Infinity, timeout: 120000
    });
    if (res.data.status === 'ok') return { fileId: res.data.data.fileId };
    return null;
  } catch { return null; }
}

// ========== AUTH ==========
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

// ========== CHUNK UPLOAD (small chunks: 15MB each) ==========
// Each chunk goes: Browser → Server (disk) → Telegram → delete from disk
// Server RAM never holds more than one chunk at a time!

app.post('/api/chunk/upload', auth, upload.single('chunk'), async (req, res) => {
  let filePath = req.file?.path;
  try {
    const { fileId, chunkIndex, totalChunks, fileName, folderId, fileSize } = req.body;
    if (!fileId || !req.file) return res.status(400).json({ error: 'Missing data' });

    const idx = parseInt(chunkIndex);
    const total = parseInt(totalChunks);

    // Read chunk from disk (small — max 15MB)
    const chunkBuffer = fs.readFileSync(filePath);
    fs.unlinkSync(filePath); filePath = null;

    // Chunk name for Telegram
    const chunkName = total > 1
      ? `${fileId}_${String(idx + 1).padStart(4, '0')}of${String(total).padStart(4, '0')}_${fileName}`
      : `${fileId}_${fileName}`;

    // Upload to both bots simultaneously
    const [tg1, tg2] = await Promise.allSettled([
      sendChunkToTelegram(BOTS[0].token, BOTS[0].channel, chunkBuffer, chunkName),
      sendChunkToTelegram(BOTS[1].token, BOTS[1].channel, chunkBuffer, chunkName),
    ]);

    // GoFile only for last chunk or single chunk (optional backup)
    let gf = null;
    if (idx === total - 1 || total === 1) {
      gf = await uploadToGoFile(chunkBuffer, chunkName).catch(() => null);
    }

    const tgResults = [
      tg1.status === 'fulfilled' ? { botIndex: 0, ...tg1.value } : null,
      tg2.status === 'fulfilled' ? { botIndex: 1, ...tg2.value } : null,
    ].filter(Boolean);

    if (!tgResults.length) throw new Error('All Telegram uploads failed');

    // If this is the last chunk, save file record to DB
    if (idx === total - 1) {
      // Get all previous chunks from temp storage in DB
      const { data: prevChunks } = await supabase.from('file_chunks_temp')
        .select('*').eq('file_id', fileId).order('chunk_index');

      const allChunks = [...(prevChunks || []), {
        chunk_index: idx,
        tg_results: tgResults,
        gf_file_id: gf?.fileId || null,
        chunk_name: chunkName,
        chunk_size: chunkBuffer.length
      }];

      // Sort by index
      allChunks.sort((a, b) => a.chunk_index - b.chunk_index);

      // Verify folder belongs to user
      const { data: folder } = await supabase.from('folders').select('id').eq('id', folderId).eq('user_id', req.user.userId).single();
      if (!folder) throw new Error('Folder not found');

      // Save final file record
      const { error: dbErr } = await supabase.from('files').insert({
        id: fileId,
        user_id: req.user.userId,
        folder_id: folderId,
        original_name: fileName,
        size: parseInt(fileSize) || 0,
        total_chunks: total,
        chunks: JSON.stringify(allChunks.map(c => ({
          index: c.chunk_index,
          fileName: c.chunk_name,
          size: c.chunk_size,
          telegram: c.tg_results,
          gofile: c.gf_file_id ? { fileId: c.gf_file_id } : null
        }))),
        download_count: 0,
        created_at: new Date().toISOString()
      });
      if (dbErr) throw dbErr;

      // Update storage
      if (parseInt(fileSize) > 0) {
        await supabase.rpc('increment_storage', { p_user_id: req.user.userId, bytes: parseInt(fileSize) }).catch(() => {});
      }

      // Clean temp chunk records
      await supabase.from('file_chunks_temp').delete().eq('file_id', fileId).catch(() => {});

      return res.json({ done: true, fileId, chunkIndex: idx });
    }

    // Not last chunk — save to temp table
    await supabase.from('file_chunks_temp').insert({
      file_id: fileId,
      chunk_index: idx,
      tg_results: tgResults,
      gf_file_id: gf?.fileId || null,
      chunk_name: chunkName,
      chunk_size: chunkBuffer.length,
      user_id: req.user.userId,
      created_at: new Date().toISOString()
    });

    res.json({ done: false, chunkIndex: idx, received: idx + 1, total });
  } catch (e) {
    if (filePath) try { fs.unlinkSync(filePath); } catch {}
    console.error('Chunk upload error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ========== DOWNLOAD PROXY ==========
app.get('/api/file/:fileId', auth, async (req, res) => {
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

    const chunks = JSON.parse(file.chunks || '[]');

    if (chunks.length === 1) {
      const chunk = chunks[0];
      const tg = chunk.telegram?.[0];
      if (tg) {
        const botToken = BOTS[tg.botIndex]?.token;
        const url = await getTgFileUrl(botToken, tg.fileId);
        if (url) {
          res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.original_name)}"`);
          res.setHeader('Content-Type', 'application/octet-stream');
          const stream = await axios.get(url, { responseType: 'stream', timeout: 300000 });
          stream.data.pipe(res);
          await supabase.from('files').update({ download_count: (file.download_count || 0) + 1 }).eq('id', req.params.fileId);
          return;
        }
      }
    }

    // Multi-part
    const parts = chunks.map((chunk, i) => ({
      part: i + 1,
      fileName: chunk.fileName,
      size: chunk.size,
      downloadUrl: `/api/file/${req.params.fileId}/part/${i}?password=${encodeURIComponent(password || '')}`
    }));
    res.json({ multiPart: true, totalParts: chunks.length, fileName: file.original_name, totalSize: file.size, parts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/file/:fileId/part/:partIdx', auth, async (req, res) => {
  try {
    const { password } = req.query;
    const { data: file } = await supabase.from('files').select('*').eq('id', req.params.fileId).single();
    if (!file) return res.status(404).json({ error: 'File not found' });

    const { data: folder } = await supabase.from('folders').select('password_hash').eq('id', file.folder_id).single();
    if (folder?.password_hash && password) {
      const valid = await bcrypt.compare(password, folder.password_hash);
      if (!valid) return res.status(403).json({ error: 'Wrong password' });
    }

    const chunks = JSON.parse(file.chunks || '[]');
    const chunk = chunks[parseInt(req.params.partIdx)];
    if (!chunk) return res.status(404).json({ error: 'Part not found' });

    const tg = chunk.telegram?.[0];
    if (tg) {
      const botToken = BOTS[tg.botIndex]?.token;
      const url = await getTgFileUrl(botToken, tg.fileId);
      if (url) {
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(chunk.fileName)}"`);
        res.setHeader('Content-Type', 'application/octet-stream');
        if (chunk.size) res.setHeader('Content-Length', chunk.size);
        const stream = await axios.get(url, { responseType: 'stream', timeout: 300000 });
        stream.data.pipe(res);
        return;
      }
    }
    res.status(500).json({ error: 'No source available' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ========== FOLDERS ==========
app.get('/api/folders', auth, async (req, res) => {
  try {
    let q = supabase.from('folders').select('id,name,parent_id,created_at').eq('user_id', req.user.userId);
    q = req.query.parent_id ? q.eq('parent_id', req.query.parent_id) : q.is('parent_id', null);
    const { data, error } = await q.order('name');
    if (error) throw error;
    res.json({ folders: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/folders', auth, async (req, res) => {
  try {
    const { name, parent_id } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const folderId = uuidv4();
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
    const { data: f } = await supabase.from('folders').select('id').eq('id', req.params.id).eq('user_id', req.user.userId).single();
    if (!f) return res.status(404).json({ error: 'Not found' });
    await supabase.from('folders').update({ name: req.body.name }).eq('id', req.params.id);
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
    const { data: f } = await supabase.from('folders').select('password_hash').eq('id', req.params.id).eq('user_id', req.user.userId).single();
    if (!f) return res.status(404).json({ error: 'Not found' });
    const valid = await bcrypt.compare(req.body.password, f.password_hash);
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
    if (f.size > 0) await supabase.rpc('increment_storage', { p_user_id: req.user.userId, bytes: -f.size }).catch(() => {});
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
    const msg = `💳 নতুন Payment!\n\nUser: ${user?.name} (${user?.email})\nTxn: ${transactionId}\nAmount: ৳${amount}\nNagad: ${nagadNumber}\n${storageTb}TB × ${months}মাস`;
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
  const { data: p } = await supabase.from('payments').select('*').eq('transaction_id', req.body.transactionId).single();
  if (!p) return res.status(404).json({ error: 'Not found' });
  const bytes = p.storage_tb * 1099511627776;
  const exp = new Date(); exp.setMonth(exp.getMonth() + p.months);
  await supabase.from('payments').update({ status: 'approved' }).eq('id', p.id);
  await supabase.from('users').update({ plan: `${p.storage_tb}TB`, plan_expires_at: exp.toISOString(), storage_limit: bytes }).eq('id', p.user_id);
  res.json({ success: true });
});

app.get('/api/admin/users', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  const { data } = await supabase.from('users').select('id,email,name,plan,storage_used,storage_limit,created_at').order('created_at', { ascending: false });
  res.json({ users: data || [] });
});

app.get('/api/config', (req, res) => res.json({ nagadNumber: NAGAD_NUMBER }));
app.get('/', (req, res) => res.json({ status: 'CloudVault API v3 ✅' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`CloudVault API v3 on port ${PORT}`));
