import './style.css';
import Matter from 'matter-js';
import imageCompression from 'browser-image-compression';
import JSZip from 'jszip';

// --------------------------------------------------------------------------
// UI Elements
// --------------------------------------------------------------------------
const dropGuide = document.getElementById('drop-guide');
const progressPanel = document.getElementById('progress-panel');
const progressList = document.getElementById('progress-list');
const resultPanel = document.getElementById('result-panel');
const sizeBeforeEl = document.getElementById('size-before');
const sizeAfterEl = document.getElementById('size-after');
const downloadsList = document.getElementById('downloads-list');
const resetBtn = document.getElementById('reset-btn');
const downloadZipBtn = document.getElementById('download-zip-btn');

// --------------------------------------------------------------------------
// Matter.js Setup
// --------------------------------------------------------------------------
const { Engine, Render, Runner, Bodies, World, Events, Composite } = Matter;

const engine = Engine.create();
const world = engine.world;

const render = Render.create({
  element: document.getElementById('canvas-container'),
  engine: engine,
  options: {
    width: window.innerWidth,
    height: window.innerHeight,
    wireframes: false,
    background: 'transparent'
  }
});

Render.run(render);

const runner = Runner.create();
Runner.run(runner, engine);

let floor, leftWall, rightWall, compressionZone;

function setupBoundaries() {
  Composite.clear(world);
  Engine.clear(engine);

  const w = window.innerWidth;
  const h = window.innerHeight;
  const th = 60;

  floor = Bodies.rectangle(w / 2, h + th / 2, w, th, { isStatic: true });
  leftWall = Bodies.rectangle(-th / 2, h / 2, th, h * 2, { isStatic: true });
  rightWall = Bodies.rectangle(w + th / 2, h / 2, th, h * 2, { isStatic: true });
  
  compressionZone = Bodies.rectangle(w / 2, h - 50, w, 100, {
    isSensor: true,
    isStatic: true,
    label: 'compressionZone',
    render: { visible: false }
  });

  World.add(world, [floor, leftWall, rightWall, compressionZone]);
}

setupBoundaries();
window.addEventListener('resize', () => {
  render.canvas.width = window.innerWidth;
  render.canvas.height = window.innerHeight;
  setupBoundaries();
});

// --------------------------------------------------------------------------
// Application State
// --------------------------------------------------------------------------
let pendingFilesCount = 0;
let totalOldSize = 0;
let totalNewSize = 0;
let compressedFiles = []; 

// --------------------------------------------------------------------------
// Drag & Drop
// --------------------------------------------------------------------------
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('drag-over');
});

window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (e.target === document.body || e.target === document.documentElement) {
    document.body.classList.remove('drag-over');
  }
});

window.addEventListener('drop', async (e) => {
  e.preventDefault();
  document.body.classList.remove('drag-over');

  if (pendingFilesCount > 0) return;

  const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
  if (files.length === 0) {
    alert('画像ファイルをドロップしてください。');
    return;
  }

  // Reset UI
  dropGuide.classList.add('hidden');
  resultPanel.classList.add('hidden');
  downloadZipBtn.classList.add('hidden');
  progressPanel.classList.remove('hidden');
  
  downloadsList.innerHTML = '';
  progressList.innerHTML = '';
  
  const oldBodies = Composite.allBodies(world).filter(b => b.label === 'droppedImage');
  if (oldBodies.length > 0) World.remove(world, oldBodies);

  pendingFilesCount = files.length;
  totalOldSize = 0;
  totalNewSize = 0;
  compressedFiles = [];

  // Spawn an initial progress UI for each file
  files.forEach((file, index) => {
    // 完全に安全でユニークなIDを生成して紐付けます。
    file._progId = 'prog-' + Math.random().toString(36).substring(2, 10);

    const div = document.createElement('div');
    div.className = 'progress-item';
    div.id = file._progId;
    div.innerHTML = `
      <div class="progress-header">
        <span class="name" title="${file.name}">${file.name}</span>
        <span class="pct">落下中...</span>
      </div>
      <div class="progress-bar-bg">
        <div class="progress-bar-fill" style="width: 0%;"></div>
      </div>
    `;
    progressList.appendChild(div);

    // Physics Object
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setTimeout(() => {
        spawnImageBody(url, img.width, img.height, file);
      }, index * 200);
    };
    img.src = url;
  });
});

// --------------------------------------------------------------------------
// Physics Objects
// --------------------------------------------------------------------------
function spawnImageBody(textureUrl, imgW, imgH, originalFile) {
  const maxW = window.innerWidth * 0.3; 
  const maxH = window.innerHeight * 0.3;
  let scale = 1;

  if (imgW > maxW || imgH > maxH) {
    scale = Math.min(maxW / imgW, maxH / imgH);
  }

  const rectW = imgW * scale;
  const rectH = imgH * scale;

  const startX = window.innerWidth / 2 + (Math.random() * 40 - 20);
  const startY = -rectH;

  const body = Bodies.rectangle(startX, startY, rectW, rectH, {
    label: 'droppedImage',
    restitution: 0.5,
    friction: 0.1,
    render: {
      sprite: {
        texture: textureUrl,
        xScale: scale,
        yScale: scale
      }
    }
  });
  
  body.originalFile = originalFile;
  body.isCompressingFlag = false;

  World.add(world, body);
}

// --------------------------------------------------------------------------
// Collision & Compression
// --------------------------------------------------------------------------
Events.on(engine, 'collisionStart', (event) => {
  const pairs = event.pairs;

  for (let i = 0; i < pairs.length; i++) {
    const bodyA = pairs[i].bodyA;
    const bodyB = pairs[i].bodyB;

    if ((bodyA.label === 'droppedImage' && bodyB.label === 'compressionZone') ||
        (bodyB.label === 'droppedImage' && bodyA.label === 'compressionZone')) {
      
      const imgBody = bodyA.label === 'droppedImage' ? bodyA : bodyB;
      
      if (imgBody.isCompressingFlag) continue;
      imgBody.isCompressingFlag = true;

      doCompression(imgBody);
    }
  }
});

function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

async function doCompression(body) {
  const file = body.originalFile;
  
  const progItem = document.getElementById(file._progId);
  let pctEl = null; 
  let fillEl = null;

  if (progItem) {
    pctEl = progItem.querySelector('.pct');
    fillEl = progItem.querySelector('.progress-bar-fill');
    if (pctEl) pctEl.textContent = '準備中...';
  }

  // 小さい画像だと圧縮が一瞬で終わり、バーが見えないまま完了してしまうのを避けるため、
  // 最低1秒間は視覚的にアニメーションを行い、物理演算ツールの「圧縮感」を演出します。
  let fakeProgress = 0;
  const fakeInterval = setInterval(() => {
    fakeProgress += Math.floor(Math.random() * 15) + 5;
    if (fakeProgress > 95) fakeProgress = 95;
    if (pctEl) pctEl.textContent = `${fakeProgress}%`;
    if (fillEl) fillEl.style.width = `${fakeProgress}%`;
  }, 100);

  try {
    const options = {
      maxSizeMB: 0.5,
      alwaysKeepResolution: true,
      useWebWorker: true,
      onProgress: (p) => { 
        // 実際のプログレスがシミュレートを上回った時のみ反映
        if (p > fakeProgress) {
          fakeProgress = p;
          if (pctEl) pctEl.textContent = `${p}%`;
          if (fillEl) fillEl.style.width = `${p}%`;
        }
      }
    };

    // 少なくとも1秒は演出時間を設ける
    const [compressedFile] = await Promise.all([
      imageCompression(file, options),
      new Promise(res => setTimeout(res, 1000))
    ]);
    
    clearInterval(fakeInterval);

    if (pctEl) pctEl.textContent = '100% (完了)';
    if (fillEl) fillEl.style.width = '100%';

    totalOldSize += file.size;
    totalNewSize += compressedFile.size;
    compressedFiles.push({
      name: file.name,
      blob: compressedFile,
      oldSize: file.size
    });

    Matter.Body.applyForce(body, body.position, {
      x: (Math.random() - 0.5) * 0.1,
      y: -0.2 * body.mass
    });

    setTimeout(() => {
      checkCompletion();
    }, 600);

  } catch (error) {
    console.error(`Compression error for ${file.name}:`, error);
    clearInterval(fakeInterval);
    if (pctEl) {
      pctEl.textContent = 'エラー';
      pctEl.style.color = '#ef4444'; 
    }
    checkCompletion();
  }
}

function checkCompletion() {
  pendingFilesCount--;
  if (pendingFilesCount <= 0) {
    showResults();
  }
}

// --------------------------------------------------------------------------
// Show Results
// --------------------------------------------------------------------------
function showResults() {
  progressPanel.classList.add('hidden'); // Hide progress
  
  sizeBeforeEl.textContent = formatBytes(totalOldSize);
  sizeAfterEl.textContent = formatBytes(totalNewSize);

  compressedFiles.forEach(f => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f.blob);
    a.download = f.name; 
    a.className = 'download-item';
    
    a.innerHTML = `
      <span class="file-name" title="${f.name}">${f.name}</span>
      <span class="file-size">${formatBytes(f.oldSize)} ➡️ ${formatBytes(f.blob.size)}</span>
    `;
    downloadsList.appendChild(a);
  });

  if (compressedFiles.length > 1) {
    downloadZipBtn.classList.remove('hidden');
  }

  Matter.Body.setStatic(floor, false); 
  setTimeout(() => {
      Matter.Body.setStatic(floor, true);
      Matter.Body.setPosition(floor, {x: window.innerWidth / 2, y: window.innerHeight + 60});
      Matter.Body.setVelocity(floor, {x: 0, y: 0});
  }, 2000);

  resultPanel.classList.remove('hidden');
}

// --------------------------------------------------------------------------
// ZIP Download Action
// --------------------------------------------------------------------------
downloadZipBtn.addEventListener('click', async () => {
  const originalText = downloadZipBtn.textContent;
  downloadZipBtn.textContent = '圧縮中...';
  downloadZipBtn.style.pointerEvents = 'none';

  try {
    const zip = new JSZip();
    compressedFiles.forEach(f => {
      zip.file(f.name, f.blob); 
    });

    const content = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(content);
    a.download = 'images.zip';
    a.click();
  } catch (err) {
    console.error(err);
    alert('ZIPファイルの作成に失敗しました。');
  } finally {
    downloadZipBtn.textContent = originalText;
    downloadZipBtn.style.pointerEvents = 'auto';
  }
});

// --------------------------------------------------------------------------
// Reset Flow
// --------------------------------------------------------------------------
resetBtn.addEventListener('click', () => {
  resultPanel.classList.add('hidden');
  progressPanel.classList.add('hidden');
  dropGuide.classList.remove('hidden');
  downloadZipBtn.classList.add('hidden');
  downloadsList.innerHTML = '';
  
  const bodiesToRemove = Composite.allBodies(world).filter(b => b.label === 'droppedImage');
  World.remove(world, bodiesToRemove);
  
  pendingFilesCount = 0;
  totalOldSize = 0;
  totalNewSize = 0;
  compressedFiles = [];
});
