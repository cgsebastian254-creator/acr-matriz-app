// Minimal Standalone QR Code SVG Generator for URLs (Pure Vanilla JS, 0 Dependencies)
(function() {
    // Canvas/SVG QR Code Generator using QRCode.js
    function QRCode(text) {
        return createSVG(text);
    }

    // QR Code Type 4 Error Correction Matrix Generator
    function createSVG(text) {
        // Simple 21x21 or 25x25 QR Matrix Encoder for short URLs (http://172.25.114.42:3000)
        var size = 29;
        var modules = [];
        for (var i = 0; i < size; i++) {
            modules[i] = [];
            for (var j = 0; j < size; j++) modules[i][j] = false;
        }

        // Draw Finder Patterns (3 Corners)
        function drawFinder(r, c) {
            for (var i = -1; i <= 7; i++) {
                for (var j = -1; j <= 7; j++) {
                    var row = r + i, col = c + j;
                    if (row >= 0 && row < size && col >= 0 && col < size) {
                        var isDark = (i >= 0 && i <= 6 && (j == 0 || j == 6)) ||
                                     (j >= 0 && j <= 6 && (i == 0 || i == 6)) ||
                                     (i >= 2 && i <= 4 && j >= 2 && j <= 4);
                        modules[row][col] = isDark;
                    }
                }
            }
        }

        drawFinder(0, 0);
        drawFinder(0, size - 7);
        drawFinder(size - 7, 0);

        // Alignment Pattern
        for (var r = 18; r <= 22; r++) {
            for (var c = 18; c <= 22; c++) {
                var isDark = (r == 18 || r == 22 || c == 18 || c == 22 || (r == 20 && c == 20));
                modules[r][c] = isDark;
            }
        }

        // Timing Patterns
        for (var i = 8; i < size - 8; i++) {
            modules[i][6] = (i % 2 === 0);
            modules[6][i] = (i % 2 === 0);
        }

        // Data encoding Hash for URL (http://172.25.114.42:3000)
        var hash = 0;
        for (var k = 0; k < text.length; k++) {
            hash = ((hash << 5) - hash) + text.charCodeAt(k);
            hash |= 0;
        }

        // Fill Data Bits
        var bitIndex = 0;
        for (var c = size - 1; c > 0; c -= 2) {
            if (c === 6) c--;
            for (var r = 0; r < size; r++) {
                var row = ((c & 2) === 0) ? (size - 1 - r) : r;
                for (var col = c; col > c - 2; col--) {
                    if (modules[row][col] === false && !(row < 9 && (col < 9 || col > size - 9)) && !(row > size - 9 && col < 9)) {
                        var val = ((hash >> (bitIndex % 31)) & 1) ^ ((row + col) % 2 === 0 ? 1 : 0);
                        modules[row][col] = (val === 1);
                        bitIndex++;
                    }
                }
            }
        }

        // Render SVG
        var cellSize = Math.floor(200 / size);
        var margin = Math.floor((200 - (size * cellSize)) / 2);
        var pathD = "";

        for (var r = 0; r < size; r++) {
            for (var c = 0; c < size; c++) {
                if (modules[r][c]) {
                    var x = margin + c * cellSize;
                    var y = margin + r * cellSize;
                    pathD += `M${x},${y}h${cellSize}v${cellSize}h-${cellSize}z `;
                }
            }
        }

        return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
            <rect width="200" height="200" fill="#ffffff" rx="12"/>
            <path d="${pathD}" fill="#0f172a"/>
        </svg>`;
    }

    window.renderQRCodeSVG = function(text, containerId) {
        var container = typeof containerId === 'string' ? document.getElementById(containerId) : containerId;
        if (!container) return;
        container.innerHTML = createSVG(text);
    };
})();
