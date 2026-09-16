(function() {
    // ──────────────────────────────────────
    // DOM elements
    // ──────────────────────────────────────
    const mainCanvas = document.getElementById('postcard-canvas');
    const mainCtx = mainCanvas.getContext('2d');
    const overlayCanvas = document.getElementById('stencil-overlay');
    const overlayCtx = overlayCanvas.getContext('2d');
    const wrapper = document.getElementById('postcard-wrapper');
    const colorPicker = document.getElementById('color-picker');
    const opacitySlider = document.getElementById('opacity-slider');
    const opacityValueEl = document.getElementById('opacity-value');
    const radiusSlider = document.getElementById('radius-slider');
    const radiusValueEl = document.getElementById('radius-value');
    const toggleStarry = document.getElementById('toggle-starry');
    const btnRemoveStencil = document.getElementById('btn-remove-stencil');
    const btnUndo = document.getElementById('btn-undo');
    const btnClear = document.getElementById('btn-clear');
    const stencilIndicator = document.getElementById('stencil-indicator');
    const btnDownload = document.getElementById('btn-download');

    const CANVAS_W = 600;
    const CANVAS_H = 400;

    // ──────────────────────────────────────
    // State
    // ──────────────────────────────────────
    let stencilImages = [null, null, null]; // Image objects (or null)
    let stencilOffscreenCanvases = [null, null, null]; // Offscreen canvases with stencil drawn at natural res
    let stencilAlphaData = [null, null, null]; // Uint8Array of alpha values per stencil
    let stencilNaturalWidth = [0, 0, 0];
    let stencilNaturalHeight = [0, 0, 0];

    let activeStencilIndex = -1; // -1 = none, 0/1/2 = stencil active
    let stencilOffsetX = 0; // position of stencil on postcard (top-left of stencil image in postcard coords)
    let stencilOffsetY = 0;
    let stencilScaleX = 1; // scale from stencil image coords to postcard coords
    let stencilScaleY = 1;

    let isDraggingStencil = false;
    let isSpraying = false;
    let dragStartMouseX = 0;
    let dragStartMouseY = 0;
    let dragStartOffsetX = 0;
    let dragStartOffsetY = 0;

    let sprayColor = '#ff3366';
    let sprayOpacity = 0.75;
    let sprayRadius = 35;
    let starrySkyMode = false;

    // Undo support: save canvas state before each spray session
    let savedCanvasState = null;

    // ──────────────────────────────────────
    // Initialize postcard
    // ──────────────────────────────────────
    function initPostcard() {
        mainCtx.fillStyle = '#fefefe';
        mainCtx.fillRect(0, 0, CANVAS_W, CANVAS_H);
        // subtle postcard border
        mainCtx.strokeStyle = '#e0dcd5';
        mainCtx.lineWidth = 1;
        mainCtx.strokeRect(0.5, 0.5, CANVAS_W - 1, CANVAS_H - 1);
        // inner subtle shadow line
        mainCtx.strokeStyle = '#f0ece5';
        mainCtx.lineWidth = 1;
        mainCtx.strokeRect(2, 2, CANVAS_W - 4, CANVAS_H - 4);
        saveCanvasStateSnapshot();
    }

    function saveCanvasStateSnapshot() {
        savedCanvasState = mainCtx.getImageData(0, 0, CANVAS_W, CANVAS_H);
    }

    function restoreCanvasStateSnapshot() {
        if (savedCanvasState) {
            mainCtx.putImageData(savedCanvasState, 0, 0);
        }
    }

    // ──────────────────────────────────────
    // Generate placeholder stencils
    // ──────────────────────────────────────
    function generatePlaceholderStencil(index) {
        const offCanvas = document.createElement('canvas');
        offCanvas.width = CANVAS_W;
        offCanvas.height = CANVAS_H;
        const ctx = offCanvas.getContext('2d');

        ctx.fillStyle = '#3a3a50';   // opaque blocking colour
        ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
        ctx.globalCompositeOperation = 'destination-out';

        if (index === 0) {
            // three circles
            const cy = CANVAS_H / 2;
            [CANVAS_W * 0.2, CANVAS_W * 0.5, CANVAS_W * 0.78].forEach((cx, i) => {
                ctx.beginPath();
                ctx.arc(cx, cy, [55, 70, 50][i], 0, Math.PI * 2);
                ctx.fill();
            });
        } else if (index === 1) {
            // diagonal stripes
            const stripeWidth = 28, spacing = 55;
            for (let d = -CANVAS_H; d < CANVAS_W + CANVAS_H; d += spacing) {
                ctx.beginPath();
                ctx.moveTo(d, 0);
                ctx.lineTo(d + stripeWidth, 0);
                ctx.lineTo(d + stripeWidth + CANVAS_H, CANVAS_H);
                ctx.lineTo(d + CANVAS_H, CANVAS_H);
                ctx.closePath();
                ctx.fill();
            }
        } else if (index === 2) {
            // star + small hole
            const cx = CANVAS_W / 2, cy = CANVAS_H / 2;
            const outerR = 130, innerR = 55;
            ctx.beginPath();
            for (let i = 0; i < 10; i++) {
                const r = i % 2 === 0 ? outerR : innerR;
                const angle = (i * Math.PI) / 5 - Math.PI / 2;
                const x = cx + Math.cos(angle) * r;
                const y = cy + Math.sin(angle) * r;
                i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            }
            ctx.closePath();
            ctx.fill();
            ctx.beginPath();
            ctx.arc(cx, cy, 30, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
        return offCanvas;
    }

    // ──────────────────────────────────────
    // Initialize stencils from PNG files
    // ──────────────────────────────────────
    const STENCIL_FILES = ['red_alpha.png', 'green_alpha.png', 'blue_alpha.png'];

    function loadStencilImages() {
        return Promise.all(STENCIL_FILES.map((filename, index) => {
            return fetch(filename)
                .then(res => {
                    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
                    return res.blob();
                })
                .then(blob => new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => {
                        const img = new Image();
                        img.onload = () => {
                            setupStencilFromImage(index, img);
                            updateThumbnail(index);
                            updateThumbnailActiveState();
                            resolve();
                        };
                        img.onerror = reject;
                        img.src = reader.result; // data: URL — same-origin, no taint
                    };
                    reader.onerror = reject;
                    reader.readAsDataURL(blob);
                }))
                .catch(err => {
                    console.warn(`Could not load stencil ${filename}:`, err);
                    const canvas = generatePlaceholderStencil(index);
                    setupStencilFromCanvas(index, canvas);
                    updateThumbnail(index);
                });
        }));
    }

    function setupStencilFromImage(index, img) {
        stencilImages[index] = img;
        stencilNaturalWidth[index] = img.naturalWidth;
        stencilNaturalHeight[index] = img.naturalHeight;

        // Create offscreen canvas at natural resolution for alpha lookup
        const offCanvas = document.createElement('canvas');
        offCanvas.width = img.naturalWidth;
        offCanvas.height = img.naturalHeight;
        const offCtx = offCanvas.getContext('2d');
        offCtx.drawImage(img, 0, 0);
        stencilOffscreenCanvases[index] = offCanvas;

        // Extract alpha data
        const imageData = offCtx.getImageData(0, 0, img.naturalWidth, img.naturalHeight);
        const alphaArr = new Uint8Array(img.naturalWidth * img.naturalHeight);
        for (let i = 0; i < alphaArr.length; i++) {
            alphaArr[i] = imageData.data[i * 4 + 3];
        }
        stencilAlphaData[index] = alphaArr;

        updateThumbnail(index);
    }

    function setupStencilFromCanvas(index, canvas) {
        console.log(index);
        stencilImages[index] = canvas;
        stencilNaturalWidth[index] = canvas.width;
        stencilNaturalHeight[index] = canvas.height;
        stencilOffscreenCanvases[index] = canvas;

        const ctx = canvas.getContext('2d');
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const alphaArr = new Uint8Array(canvas.width * canvas.height);
        for (let i = 0; i < alphaArr.length; i++) {
            alphaArr[i] = imageData.data[i * 4 + 3];
        }
        stencilAlphaData[index] = alphaArr;

        updateThumbnail(index);
    }

    function updateThumbnail(index) {
        const thumbCanvas = document.getElementById(`stencil-thumb-${index}`);
        if (!thumbCanvas) return;
        const thumbCtx = thumbCanvas.getContext('2d');
        thumbCtx.clearRect(0, 0, thumbCanvas.width, thumbCanvas.height);

        // Draw checkerboard for transparency visualization
        const cs = 8;
        for (let y = 0; y < thumbCanvas.height; y += cs) {
            for (let x = 0; x < thumbCanvas.width; x += cs) {
                thumbCtx.fillStyle = (Math.floor(x / cs) + Math.floor(y / cs)) % 2 === 0 ? '#c8c8c8' :
                    '#a0a0a0';
                thumbCtx.fillRect(x, y, cs, cs);
            }
        }

        if (stencilImages[index]) {
            const source = stencilImages[index];
            const srcWidth = source.naturalWidth || source.width;   // works for both Image and Canvas
            const srcHeight = source.naturalHeight || source.height;
            const scale = Math.min(thumbCanvas.width / srcWidth, thumbCanvas.height / srcHeight);
            const dw = srcWidth * scale;
            const dh = srcHeight * scale;
            const dx = (thumbCanvas.width - dw) / 2;
            const dy = (thumbCanvas.height - dh) / 2;
            thumbCtx.drawImage(source, dx, dy, dw, dh);
        }
    }

    function updateAllThumbnails() {
        for (let i = 0; i < 3; i++) {
            updateThumbnail(i);
        }
    }

    function updateThumbnailActiveState() {
        for (let i = 0; i < 3; i++) {
            const thumb = document.getElementById(`stencil-thumb-${i}`);
            if (thumb) {
                if (i === activeStencilIndex) {
                    thumb.classList.add('active');
                } else {
                    thumb.classList.remove('active');
                }
            }
        }
    }

    // ──────────────────────────────────────
    // Initialize placeholder stencils
    // ──────────────────────────────────────
    function initPlaceholderStencils() {
        for (let i = 0; i < 3; i++) {
            const canvas = generatePlaceholderStencil(i);   // returns a canvas directly
            setupStencilFromCanvas(i, canvas);              // synchronous, no onload
        }
    }

    // ──────────────────────────────────────
    // Stencil activation / deactivation
    // ──────────────────────────────────────
    function activateStencil(index) {
        if (index < 0 || index >= 3 || !stencilImages[index]) return;

        if (activeStencilIndex === index) {
            // Already active — deactivate
            deactivateStencil();
            return;
        }

        activeStencilIndex = index;

        // Scale stencil to fit within postcard while maintaining aspect ratio
        const imgW = stencilNaturalWidth[index];
        const imgH = stencilNaturalHeight[index];
        const scale = Math.min(CANVAS_W / imgW, CANVAS_H / imgH);
        stencilScaleX = scale;
        stencilScaleY = scale;

        // Center the stencil on the postcard
        const displayW = imgW * scale;
        const displayH = imgH * scale;
        stencilOffsetX = (CANVAS_W - displayW) / 2;
        stencilOffsetY = (CANVAS_H - displayH) / 2;

        updateOverlay();
        updateUIState();
        updateThumbnailActiveState();
    }

    function deactivateStencil() {
        activeStencilIndex = -1;
        stencilOffsetX = 0;
        stencilOffsetY = 0;
        stencilScaleX = 1;
        stencilScaleY = 1;
        clearOverlay();
        updateUIState();
        updateThumbnailActiveState();
    }

    function clearOverlay() {
        overlayCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    }

    function updateOverlay() {
        clearOverlay();
        if (activeStencilIndex >= 0 && stencilImages[activeStencilIndex]) {
            const img = stencilImages[activeStencilIndex];
            const dw = stencilNaturalWidth[activeStencilIndex] * stencilScaleX;
            const dh = stencilNaturalHeight[activeStencilIndex] * stencilScaleY;
            overlayCtx.drawImage(img, stencilOffsetX, stencilOffsetY, dw, dh);

            // Draw subtle dashed outline around stencil bounds
            overlayCtx.save();
            overlayCtx.setLineDash([6, 4]);
            overlayCtx.strokeStyle = 'rgba(255,255,255,0.5)';
            overlayCtx.lineWidth = 2;
            overlayCtx.strokeRect(stencilOffsetX, stencilOffsetY, dw, dh);
            overlayCtx.setLineDash([]);
            overlayCtx.restore();
        }
    }

    function updateUIState() {
        const hasActiveStencil = activeStencilIndex >= 0;
        btnRemoveStencil.disabled = !hasActiveStencil;
        if (hasActiveStencil) {
            stencilIndicator.textContent = `📌 Stencil ${activeStencilIndex + 1} active`;
            stencilIndicator.classList.remove('none');
        } else {
            stencilIndicator.textContent = 'No stencil active';
            stencilIndicator.classList.add('none');
        }
        updateThumbnailActiveState();
    }

    // ──────────────────────────────────────
    // Spray paint logic
    // ──────────────────────────────────────
    function getStencilAlphaAt(postcardX, postcardY) {
        if (activeStencilIndex < 0 || !stencilAlphaData[activeStencilIndex]) {
            return 0; // No stencil = fully transparent = paint passes
        }

        const imgW = stencilNaturalWidth[activeStencilIndex];
        const imgH = stencilNaturalHeight[activeStencilIndex];

        // Convert postcard coordinates to stencil image coordinates
        const sx = (postcardX - stencilOffsetX) / stencilScaleX;
        const sy = (postcardY - stencilOffsetY) / stencilScaleY;

        // Round to nearest pixel
        const px = Math.round(sx);
        const py = Math.round(sy);

        // Check bounds
        if (px < 0 || py < 0 || px >= imgW || py >= imgH) {
            return 0; // Outside stencil bounds = no blocking = paint passes
        }

        const alpha = stencilAlphaData[activeStencilIndex][py * imgW + px];
        return alpha; // 0 = transparent (paint passes), 255 = opaque (paint blocked)
    }

    function isPaintBlocked(postcardX, postcardY) {
        const alpha = getStencilAlphaAt(postcardX, postcardY);
        // If stencil alpha > 128, the stencil is occluding — paint is BLOCKED
        return alpha > 128;
    }

    function sprayDot(x, y, radius, color, opacity) {
        if (x < 0 || y < 0 || x >= CANVAS_W || y >= CANVAS_H) return;
        if (isPaintBlocked(x, y)) return;

        mainCtx.save();
        // Use radial gradient for soft spray dot
        const gradient = mainCtx.createRadialGradient(x, y, 0, x, y, radius);
        const r = parseInt(color.slice(1, 3), 16);
        const g = parseInt(color.slice(3, 5), 16);
        const b = parseInt(color.slice(5, 7), 16);
        gradient.addColorStop(0, `rgba(${r},${g},${b},${opacity})`);
        gradient.addColorStop(0.5, `rgba(${r},${g},${b},${opacity * 0.7})`);
        gradient.addColorStop(1, `rgba(${r},${g},${b},0)`);
        mainCtx.fillStyle = gradient;
        mainCtx.beginPath();
        mainCtx.arc(x, y, radius, 0, Math.PI * 2);
        mainCtx.fill();
        mainCtx.restore();
    }

    function sprayBurst(centerX, centerY) {
        const radius = sprayRadius;
        const color = sprayColor;
        const opacity = sprayOpacity;

        if (starrySkyMode) {
            // Large radius, few scattered "star" dots
            const numDots = Math.floor(Math.random() * 10) + 4; // 4-13 dots
            const dotRadius = 2.5 + Math.random() * 3.5; // larger dots
            for (let i = 0; i < numDots; i++) {
                // Random position within the large radius (using sqrt for uniform area distribution)
                const angle = Math.random() * Math.PI * 2;
                const dist = Math.sqrt(Math.random()) * radius;
                const dx = Math.cos(angle) * dist;
                const dy = Math.sin(angle) * dist;
                sprayDot(centerX + dx, centerY + dy, dotRadius, color, opacity);
            }
        } else {
            // Normal mode: dense spray within radius
            const numDots = Math.floor(radius * 1.8) + 15; // more dots for larger radius
            const dotRadius = 0.8 + Math.random() * 1.6;
            for (let i = 0; i < numDots; i++) {
                const angle = Math.random() * Math.PI * 2;
                const dist = Math.sqrt(Math.random()) * radius;
                const dx = Math.cos(angle) * dist;
                const dy = Math.sin(angle) * dist;
                const variation = 0.6 + Math.random() * 0.4;
                sprayDot(centerX + dx, centerY + dy, dotRadius * variation, color, opacity * variation);
            }
        }
    }

    // ──────────────────────────────────────
    // Spray animation loop
    // ──────────────────────────────────────
    let sprayFrameId = null;
    let lastSprayTime = 0;
    const SPRAY_INTERVAL = 1000 / 50; // ~50 sprays per second max

    function startSpraying() {
        if (isSpraying) return;
        isSpraying = true;
        lastSprayTime = 0;
        sprayFrameId = requestAnimationFrame(sprayLoop);
    }

    function stopSpraying() {
        isSpraying = false;
        if (sprayFrameId) {
            cancelAnimationFrame(sprayFrameId);
            sprayFrameId = null;
        }
    }

    function sprayLoop(timestamp) {
        if (!isSpraying) return;

        if (timestamp - lastSprayTime >= SPRAY_INTERVAL) {
            lastSprayTime = timestamp;
            const pos = getMousePosFromLastEvent();
            if (pos) {
                sprayBurst(pos.x, pos.y);
            }
        }

        sprayFrameId = requestAnimationFrame(sprayLoop);
    }

    let lastMouseEvent = null;

    function getMousePosFromLastEvent() {
        return lastMouseEvent;
    }

    function updateLastMouseEvent(e) {
        const rect = wrapper.getBoundingClientRect();
        const scaleX = CANVAS_W / rect.width;
        const scaleY = CANVAS_H / rect.height;
        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;
        lastMouseEvent = { x, y };
        return lastMouseEvent;
    }

    // ──────────────────────────────────────
    // Check if a point is on an opaque part of the active stencil
    // ──────────────────────────────────────
    function isOnOpaqueStencil(postcardX, postcardY) {
        if (activeStencilIndex < 0) return false;
        const alpha = getStencilAlphaAt(postcardX, postcardY);
        return alpha > 128;
    }

    function isWithinStencilBounds(postcardX, postcardY) {
        if (activeStencilIndex < 0) return false;
        const imgW = stencilNaturalWidth[activeStencilIndex];
        const imgH = stencilNaturalHeight[activeStencilIndex];
        const dw = imgW * stencilScaleX;
        const dh = imgH * stencilScaleY;
        return (
            postcardX >= stencilOffsetX &&
            postcardX <= stencilOffsetX + dw &&
            postcardY >= stencilOffsetY &&
            postcardY <= stencilOffsetY + dh
        );
    }

    // ──────────────────────────────────────
    // Event handling
    // ──────────────────────────────────────
    wrapper.addEventListener('mousedown', handlePointerDown);
    wrapper.addEventListener('mousemove', handlePointerMove);
    window.addEventListener('mouseup', handlePointerUp);
    window.addEventListener('mouseleave', handlePointerUp);

    wrapper.addEventListener('touchstart', handleTouchStart, { passive: false });
    wrapper.addEventListener('touchmove', handleTouchMove, { passive: false });
    window.addEventListener('touchend', handlePointerUp);
    window.addEventListener('touchcancel', handlePointerUp);

    function getEventPos(e) {
        const rect = wrapper.getBoundingClientRect();
        const scaleX = CANVAS_W / rect.width;
        const scaleY = CANVAS_H / rect.height;
        let clientX, clientY;
        if (e.touches && e.touches.length > 0) {
            clientX = e.touches[0].clientX;
            clientY = e.touches[0].clientY;
        } else if (e.changedTouches && e.changedTouches.length > 0) {
            clientX = e.changedTouches[0].clientX;
            clientY = e.changedTouches[0].clientY;
        } else {
            clientX = e.clientX;
            clientY = e.clientY;
        }
        return {
            x: (clientX - rect.left) * scaleX,
            y: (clientY - rect.top) * scaleY,
            clientX,
            clientY,
        };
    }

    function handlePointerDown(e) {
        if (e.button !== undefined && e.button !== 0) return; // only left button
        const pos = getEventPos(e);
        updateLastMouseEvent(e);
        console.log('down: activeStencilIndex =', activeStencilIndex,
            'scale =', stencilScaleX, stencilScaleY,
            'offset =', stencilOffsetX, stencilOffsetY,
            'natural =', stencilNaturalWidth[activeStencilIndex], stencilNaturalHeight[activeStencilIndex]);
        // Always start spraying – the stencil will still block the paint where it's opaque
        saveCanvasStateSnapshot();
        lastMouseEvent = { x: pos.x, y: pos.y };
        startSpraying();
        sprayBurst(pos.x, pos.y);
        e.preventDefault();
    }

    function handlePointerMove(e) {
        const pos = getEventPos(e);
        updateLastMouseEvent(e);

        if (isSpraying) {
            lastMouseEvent = { x: pos.x, y: pos.y };
            e.preventDefault();
        }
    }

    function handlePointerUp(e) {
        if (isSpraying) {
            stopSpraying();
        }
    }

    function handleTouchStart(e) {
        if (e.touches.length === 1) {
            const fakeE = { ...e, button: 0, touches: e.touches, changedTouches: e.changedTouches };
            handlePointerDown(fakeE);
        }
    }

    function handleTouchMove(e) {
        if (e.touches.length === 1 && (isDraggingStencil || isSpraying)) {
            const fakeE = { ...e, touches: e.touches, changedTouches: e.changedTouches };
            handlePointerMove(fakeE);
        }
    }

    // ──────────────────────────────────────
    // Button handlers
    // ──────────────────────────────────────
    btnRemoveStencil.addEventListener('click', () => {
        deactivateStencil();
    });

    btnUndo.addEventListener('click', () => {
        restoreCanvasStateSnapshot();
    });

    btnClear.addEventListener('click', () => {
        if (confirm('Clear the entire postcard? This cannot be undone.')) {
            mainCtx.fillStyle = '#fefefe';
            mainCtx.fillRect(0, 0, CANVAS_W, CANVAS_H);
            mainCtx.strokeStyle = '#e0dcd5';
            mainCtx.lineWidth = 1;
            mainCtx.strokeRect(0.5, 0.5, CANVAS_W - 1, CANVAS_H - 1);
            mainCtx.strokeStyle = '#f0ece5';
            mainCtx.strokeRect(2, 2, CANVAS_W - 4, CANVAS_H - 4);
            saveCanvasStateSnapshot();
        }
    });

    btnDownload.addEventListener('click', () => {
        // toDataURL works even with the stencil overlay on top —
        // we only export the main canvas (the painted postcard).
        console.log('Download function');
        const dataURL = mainCanvas.toDataURL('image/png');

        const link = document.createElement('a');
        link.download = `postcard-${Date.now()}.png`;
        link.href = dataURL;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    });

    toggleStarry.addEventListener('click', () => {
        starrySkyMode = !starrySkyMode;
        if (starrySkyMode) {
            toggleStarry.classList.add('active');
            // Increase default radius for starry mode if currently small
            if (sprayRadius < 70) {
                sprayRadius = 120;
                radiusSlider.value = 120;
                radiusValueEl.textContent = '120';
            }
        } else {
            toggleStarry.classList.remove('active');
        }
    });

    // ──────────────────────────────────────
    // Control bindings
    // ──────────────────────────────────────
    colorPicker.addEventListener('input', () => {
        sprayColor = colorPicker.value;
    });
    sprayColor = colorPicker.value;

    opacitySlider.addEventListener('input', () => {
        sprayOpacity = parseInt(opacitySlider.value) / 100;
        opacityValueEl.textContent = opacitySlider.value + '%';
    });
    sprayOpacity = parseInt(opacitySlider.value) / 100;
    opacityValueEl.textContent = opacitySlider.value + '%';

    radiusSlider.addEventListener('input', () => {
        sprayRadius = parseInt(radiusSlider.value);
        radiusValueEl.textContent = sprayRadius;
    });
    sprayRadius = parseInt(radiusSlider.value);
    radiusValueEl.textContent = sprayRadius;

    // ──────────────────────────────────────
    // Stencil thumbnail clicks
    // ──────────────────────────────────────
    document.getElementById('stencil-panel').addEventListener('click', (e) => {
        const thumb = e.target.closest('.stencil-thumb');
        if (thumb) {
            const slot = thumb.closest('.stencil-slot');
            if (slot) {
                const index = parseInt(slot.dataset.index);
                if (!isNaN(index) && stencilImages[index]) {
                    activateStencil(index);
                }
            }
        }
    });

    // ──────────────────────────────────────
    // File uploads for custom stencils
    // ──────────────────────────────────────
    document.querySelectorAll('.stencil-upload').forEach(input => {
        input.addEventListener('change', (e) => {
            const index = parseInt(input.dataset.index);
            const file = e.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (ev) => {
                const img = new Image();
                img.onload = () => {
                    setupStencilFromImage(index, img);
                    // If this stencil was active, update overlay
                    if (activeStencilIndex === index) {
                        // Recalculate scale & offset for new stencil
                        const scale = Math.min(CANVAS_W / img.naturalWidth, CANVAS_H / img
                            .naturalHeight);
                        stencilScaleX = scale;
                        stencilScaleY = scale;
                        const displayW = img.naturalWidth * scale;
                        const displayH = img.naturalHeight * scale;
                        stencilOffsetX = (CANVAS_W - displayW) / 2;
                        stencilOffsetY = (CANVAS_H - displayH) / 2;
                        updateOverlay();
                    }
                    updateThumbnail(index);
                    updateThumbnailActiveState();
                };
                img.src = ev.target.result;
            };
            reader.readAsDataURL(file);
        });
    });

    // ──────────────────────────────────────
    // Keyboard shortcuts
    // ──────────────────────────────────────
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            deactivateStencil();
        }
        if (e.key === '1' && !e.ctrlKey && !e.metaKey) {
            if (stencilImages[0]) activateStencil(0);
        }
        if (e.key === '2' && !e.ctrlKey && !e.metaKey) {
            if (stencilImages[1]) activateStencil(1);
        }
        if (e.key === '3' && !e.ctrlKey && !e.metaKey) {
            if (stencilImages[2]) activateStencil(2);
        }
        if (e.key === '0' && !e.ctrlKey && !e.metaKey) {
            deactivateStencil();
        }
        if (e.ctrlKey && e.key === 'z') {
            e.preventDefault();
            restoreCanvasStateSnapshot();
        }
    });

    // ──────────────────────────────────────
    // Initialization
    // ──────────────────────────────────────
    function init() {
        initPostcard();
        loadStencilImages().then(() => {
            updateAllThumbnails();
            updateUIState();
        });
        updateUIState();

        // Give placeholder images a moment to load, then update thumbnails
        setTimeout(() => {
            updateAllThumbnails();
        }, 300);
    }

    init();

    console.log('🖌️ Stencil Spray Postcard Studio ready!');
    console.log('  - Click stencil thumbnails on the right to place them');
    console.log('  - Click & drag on opaque stencil areas to reposition');
    console.log('  - Click & drag on transparent areas to spray paint');
    console.log('  - Use arrow keys to nudge stencil (Shift for larger steps)');
    console.log('  - Press 1/2/3 to quickly switch stencils, 0 or Esc to remove');
    console.log('  - Toggle "Starry Sky" for scattered star-like spray patterns');
    console.log('  - Upload your own PNG stencils using the file inputs');
    console.log('  - Ctrl+Z to undo last spray session');
})();
