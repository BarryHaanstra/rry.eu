/*
 * A pink neon sign of the logo, spinning above a wet street in a dark-blue
 * neon city, in the rain.
 *
 * Everything is drawn with Canvas 2D on one canvas: no libraries, no
 * network requests. The sign is a real (tiny) 3D model: the logo outline is
 * turned into a polygon, extruded, rotated and projected with perspective.
 * Solid shaded sides hide what's behind them and the near side is drawn
 * larger, so the eye can't read the spin backwards.
 */
(function () {
	'use strict';

	// Logo outline (viewBox 0 0 165 150), absolute M/L/H/V/C/Z commands only
	var LOGO_D = 'M82.0625 32.1875L109 0H133.5L91.4375 50.3125V56.249H125.938C146.771 56.249 157.188 65.624 157.188 84.374C157.187 103.124 146.771 112.499 125.938 112.499H120.125L164.125 149.999H135.312L91.4375 112.605V93.749H122.812C133.229 93.749 138.437 90.6239 138.438 84.374C138.438 78.124 133.229 74.999 122.812 74.999H91.4375V93.75H72.6875V74.999H41.3125C30.8958 74.999 25.6875 78.124 25.6875 84.374C25.6876 90.6239 30.8959 93.749 41.3125 93.749H72.6875V112.605L28.8125 149.999H0L44 112.499H38.1875C17.3542 112.499 6.93757 103.124 6.9375 84.374C6.9375 65.624 17.3542 56.249 38.1875 56.249H72.6875V50.3125L30.625 0H55.125L82.0625 32.1875Z';
	var LW = 165, LH = 150;

	var SPIN_SPEED = 0.9;   // radians per second (one turn in about 7 s)
	var DEPTH = 14;         // sign thickness, in logo units
	var CAMERA = 320;       // camera distance, in logo units (smaller = stronger perspective)
	var MAX_DPR = 2;

	var NEON = '#ff3d9a';
	var NEON_RGB = '255,61,154';
	var CORE = '#ffe3f1';

	// Light for the sides: from the upper left, in front of the sign
	var LIGHT = (function () {
		var l = [-0.45, -0.55, 0.7], n = Math.hypot(l[0], l[1], l[2]);
		return [l[0] / n, l[1] / n, l[2] / n];
	})();

	var canvas, ctx, width, height, dpr, overscan;
	var drops = [];
	var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
	var last = 0, t0 = 0;

	function rand(a, b) {
		return a + Math.random() * (b - a);
	}

	// ---------- Geometry ----------

	// The outline as a polygon centred on (0, 0), with each curve cut into
	// short straight pieces, plus the outward normal of every edge
	var OUTLINE = (function () {
		var tok = LOGO_D.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g);
		var pts = [], i = 0, cmd = '', x = 0, y = 0;
		function num() { return parseFloat(tok[i++]); }

		while (i < tok.length) {
			if (/[A-Za-z]/.test(tok[i])) cmd = tok[i++];
			if (cmd === 'M' || cmd === 'L') { x = num(); y = num(); pts.push([x, y]); }
			else if (cmd === 'H') { x = num(); pts.push([x, y]); }
			else if (cmd === 'V') { y = num(); pts.push([x, y]); }
			else if (cmd === 'C') {
				var x1 = num(), y1 = num(), x2 = num(), y2 = num(), x3 = num(), y3 = num();
				for (var k = 1; k <= 10; k++) {
					var t = k / 10, m = 1 - t;
					pts.push([
						m * m * m * x + 3 * m * m * t * x1 + 3 * m * t * t * x2 + t * t * t * x3,
						m * m * m * y + 3 * m * m * t * y1 + 3 * m * t * t * y2 + t * t * t * y3
					]);
				}
				x = x3; y = y3;
			}
			else if (i < tok.length && !/[A-Za-z]/.test(tok[i])) i++; // Z takes no numbers
		}

		var first = pts[0], lastPt = pts[pts.length - 1];
		if (Math.abs(first[0] - lastPt[0]) < 1e-3 && Math.abs(first[1] - lastPt[1]) < 1e-3) pts.pop();
		pts = pts.map(function (p) { return [p[0] - LW / 2, p[1] - LH / 2]; });

		var area = 0;
		for (var j = 0; j < pts.length; j++) {
			var p = pts[j], q = pts[(j + 1) % pts.length];
			area += p[0] * q[1] - q[0] * p[1];
		}
		var sign = area > 0 ? 1 : -1;
		var normals = pts.map(function (p, j) {
			var q = pts[(j + 1) % pts.length];
			var dx = q[0] - p[0], dy = q[1] - p[1], len = Math.hypot(dx, dy) || 1;
			return [sign * dy / len, -sign * dx / len];
		});
		return { pts: pts, normals: normals };
	})();

	// ---------- Flicker: a steady hum, with a stutter every few seconds ----------

	var nextFlicker = 3, flickerEnd = 0;

	function neonLevel(t) {
		if (reduceMotion.matches) return 1;
		if (t > nextFlicker) {
			flickerEnd = t + rand(0.25, 0.7);
			nextFlicker = t + rand(4, 9);
		}
		if (t < flickerEnd) return Math.random() < 0.45 ? 0.08 : rand(0.6, 1);
		return 0.94 + 0.06 * Math.sin(t * 90);
	}

	// ---------- The sign ----------

	// The tube itself: pink glass with a white-hot core, no glow
	function tube(path, w, alpha) {
		var prev = ctx.globalAlpha;
		ctx.globalAlpha = prev * alpha;
		ctx.lineWidth = w;
		ctx.strokeStyle = NEON;
		ctx.stroke(path);
		ctx.lineWidth = w * 0.38;
		ctx.strokeStyle = CORE;
		ctx.stroke(path);
		ctx.globalAlpha = prev;
	}

	// The tube's glow, added as light. Drawn in place: an offset shadow
	// gets snapped to whole pixels and wobbles against the tube.
	function glow(path, w, strength) {
		if (strength <= 0.01) return;
		ctx.save();
		ctx.globalCompositeOperation = 'lighter';
		ctx.globalAlpha *= strength;
		ctx.shadowColor = NEON;
		ctx.shadowBlur = w * 6 * dpr;
		ctx.lineWidth = w * 1.6;
		ctx.strokeStyle = 'rgba(' + NEON_RGB + ',0.45)';
		ctx.stroke(path);
		ctx.shadowBlur = w * 2 * dpr;
		ctx.stroke(path);
		ctx.restore();
	}

	// Colour of a surface of the sign's body, from its normal (Z = to viewer).
	// Faces and sides use the same light, so the body reads as one solid.
	function bodyColor(nx, ny, nz, level) {
		// Even base light, light from the viewer's side (so whatever faces you
		// is never dark, which would read as looking into a hollow sign), and
		// the key light from the upper left for shading
		var key = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
		var shade = 0.3 + 0.3 * Math.max(0, nz) + 0.4 * key;
		return 'rgb(' + Math.round(22 + shade * 95 + level * 55) + ',' +
			Math.round(11 + shade * 50 + level * 8) + ',' +
			Math.round(20 + shade * 80 + level * 32) + ')';
	}

	// The sign's solid body is drawn opaque on this layer first, then laid
	// over the scene in one go, so it is evenly see-through everywhere
	var layer = document.createElement('canvas');
	var lctx = layer.getContext('2d');
	var BODY_ALPHA = 0.8; // the body lets 20% of what's behind it through, back tube included
	var EDGE_FADE = 0.12; // cos(angle) below which the near tube fades to match the far one (about 7°)

	function facePath(pts) {
		var p = new Path2D();
		p.moveTo(pts[0][0], pts[0][1]);
		for (var i = 1; i < pts.length; i++) p.lineTo(pts[i][0], pts[i][1]);
		p.closePath();
		return p;
	}

	// Glass tube, visible even when the neon is off
	function glass(path, w, alpha) {
		var prev = ctx.globalAlpha;
		ctx.globalAlpha = prev * (alpha === undefined ? 1 : alpha);
		ctx.lineWidth = w * 1.2;
		ctx.strokeStyle = '#3a1a33';
		ctx.stroke(path);
		ctx.globalAlpha = prev;
	}

	// Panel colour in the street reflection: the first version's shading
	function reflectionColor(nx, ny, nz, level) {
		var shade = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
		return 'rgb(' + Math.round(22 + shade * 95 + level * 55) + ',' +
			Math.round(11 + shade * 50 + level * 8) + ',' +
			Math.round(20 + shade * 80 + level * 32) + ')';
	}

	// A face panel, lit like the sides
	function panel(path, color) {
		lctx.fillStyle = color;
		lctx.fill(path);
	}

	// full: false for the reflection, which has no sides and no glow
	function drawSign(cx, cy, size, angle, level, full) {
		var k = size / LW, w = 3 * k;
		var c = Math.cos(angle), s = Math.sin(angle);
		var pts = OUTLINE.pts, normals = OUTLINE.normals, n = pts.length;
		var half = DEPTH / 2;
		var lit = level >= 0.1;

		// Rotate around the vertical axis, then project. Z points at the viewer.
		function project(x, y, z) {
			var X = x * c + z * s, Z = -x * s + z * c;
			var f = CAMERA / (CAMERA - Z);
			return [cx + X * k * f, cy + y * k * f, X, Z];
		}

		var front = [], back = [];
		for (var i = 0; i < n; i++) {
			front.push(project(pts[i][0], pts[i][1], half));
			back.push(project(pts[i][0], pts[i][1], -half));
		}
		// Both faces carry neon and are always lit
		var nearFace = facePath(c >= 0 ? front : back);
		var farFace = facePath(c >= 0 ? back : front);
		var d = c >= 0 ? 1 : -1; // the near face's normal is d * (s, 0, c)
		var nearColor = bodyColor(d * s, 0, d * c, level);
		var farColor = bodyColor(-d * s, 0, -d * c, level);

		// The reflection in the street keeps the first version's look: solid
		// panels with the original shading, both tubes, no glow
		if (!full) {
			ctx.lineJoin = 'round';
			ctx.lineCap = 'round';
			glass(farFace, w);
			if (lit) tube(farFace, w, level);
			ctx.fillStyle = reflectionColor(-d * s, 0, -d * c, level);
			ctx.fill(farFace);
			ctx.fillStyle = reflectionColor(d * s, 0, d * c, level);
			ctx.fill(nearFace);
			glass(nearFace, w);
			if (lit) tube(nearFace, w, level);
			return;
		}

		ctx.lineJoin = 'round';
		ctx.lineCap = 'round';

		// 1. Both tubes behind the body, treated exactly alike: they glow
		//    faintly through it, and fully wherever they stick out past it
		glass(farFace, w);
		if (full) {
			glass(nearFace, w);
			if (lit) {
				glow(farFace, w, level);
				tube(farFace, w, level);
				glow(nearFace, w, level);
				tube(nearFace, w, level);
			}
		}

		// 2. The body, opaque on the layer (far face, sides far to near, near
		//    face), then laid over the scene at BODY_ALPHA
		lctx.setTransform(1, 0, 0, 1, 0, 0);
		lctx.clearRect(0, 0, layer.width, layer.height);
		lctx.setTransform(ctx.getTransform());
		panel(farFace, farColor);
		if (full) {
			var quads = [];
			for (var j = 0; j < n; j++) {
				var j2 = (j + 1) % n;
				var nx = normals[j][0] * c, ny = normals[j][1], nz = -normals[j][0] * s;
				// Facing test against the direction to the camera, from the edge midpoint
				var mx = (front[j][2] + front[j2][2] + back[j][2] + back[j2][2]) / 4;
				var my = (pts[j][1] + pts[j2][1]) / 2;
				var mz = (front[j][3] + back[j][3]) / 2;
				if (nx * -mx + ny * -my + nz * (CAMERA - mz) <= 0) continue;

				quads.push({ z: mz, a: front[j], b: front[j2], c: back[j2], d: back[j], color: bodyColor(nx, ny, nz, level) });
			}
			quads.sort(function (p, q) { return p.z - q.z; });
			lctx.lineJoin = 'round';
			lctx.lineWidth = 0.75; // covers hairline seams between neighbours
			for (var qi = 0; qi < quads.length; qi++) {
				var qd = quads[qi];
				lctx.beginPath();
				lctx.moveTo(qd.a[0], qd.a[1]);
				lctx.lineTo(qd.b[0], qd.b[1]);
				lctx.lineTo(qd.c[0], qd.c[1]);
				lctx.lineTo(qd.d[0], qd.d[1]);
				lctx.closePath();
				lctx.fillStyle = qd.color;
				lctx.strokeStyle = qd.color;
				lctx.fill();
				lctx.stroke();
			}
		}
		// The near panel faces the camera only while |cos| * CAMERA > half:
		// with perspective it turns away just before edge-on. Drawing it after
		// that would paint its back over the sides, like looking into the sign.
		if (Math.abs(c) * CAMERA > half) panel(nearFace, nearColor);

		ctx.save();
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.globalAlpha *= BODY_ALPHA;
		ctx.drawImage(layer, 0, 0);
		ctx.restore();

		// 3. The near tube is in front of the body, so it is drawn once more on
		//    top. Near edge-on that fades out, so at the swap both tubes are
		//    drawn exactly alike (step 1 only) and neither glow nor glass jumps
		//    from one side to the other.
		if (!full) {
			glass(nearFace, w);
			if (lit) tube(nearFace, w, level);
			return;
		}
		var e = Math.max(0, 1 - Math.abs(c) / EDGE_FADE);
		e = e * e * (3 - 2 * e);
		if (e < 1) {
			glass(nearFace, w, 1 - e);
			if (lit) {
				glow(nearFace, w, level * (1 - e));
				tube(nearFace, w, level * (1 - e));
			}
		}
	}

	// ---------- City ----------
	//
	// A dark-blue skyline in three layers fading into haze. It is generated
	// once (from a fixed seed, so it looks the same on every visit) and drawn
	// to an offscreen canvas on resize; per frame only the lights move.

	function seeded(seed) {
		return function () {
			seed = (seed * 16807) % 2147483647;
			return (seed - 1) / 2147483646;
		};
	}

	var CITY_NEONS = ['#2de2e6', '#9b5cff', '#ffb347', '#3d7bff', '#2de2e6', '#c86bff'];
	var CITY_WINDOWS = ['120,220,255', '150,170,255', '255,190,110', '120,220,255', '190,140,255'];

	// Towers in relative units: x and width by screen width, height by screen height
	function towers(R, o) {
		var out = [], x = o.x0;
		while (x < o.x1) {
			var w = o.minW + R() * (o.maxW - o.minW);
			var h = o.minH + R() * (o.maxH - o.minH);
			var t = { x: x, w: w, h: h, step: R() < 0.35 ? 0.25 + R() * 0.3 : 0, spire: R() < (o.spires || 0.25), win: [], strips: [], signs: [] };
			t.cols = Math.max(2, Math.round(w * o.cols));
			t.rows = Math.max(3, Math.round(h * o.rows));
			for (var r = 0; r < t.rows; r++) {
				for (var c = 0; c < t.cols; c++) {
					if (R() < o.lit) t.win.push([c, r, CITY_WINDOWS[Math.floor(R() * CITY_WINDOWS.length)], 0.25 + R() * 0.6]);
				}
			}
			if (R() < o.strips) t.strips.push({ u: R() < 0.5 ? 0.06 : 0.94, v0: R() * 0.25, v1: 0.45 + R() * 0.5, col: CITY_NEONS[Math.floor(R() * CITY_NEONS.length)] });
			if (R() < o.signs) t.signs.push({ u: 0.12 + R() * 0.4, v: 0.08 + R() * 0.45, sw: 0.35 + R() * 0.45, sh: 0.05 + R() * 0.08, col: CITY_NEONS[Math.floor(R() * CITY_NEONS.length)] });
			out.push(t);
			x += w + R() * o.gap;
		}
		return out;
	}

	var CITY = (function () {
		var R = seeded(11);
		return [
			{ body: '#0c1634', fog: [0.3, 'rgba(25,45,110,.55)'], towers: towers(R, { x0: -0.02, x1: 1.02, minW: 0.03, maxW: 0.07, minH: 0.18, maxH: 0.42, cols: 60, rows: 60, lit: 0.18, strips: 0.2, signs: 0.05, gap: 0.008, spires: 0.35 }) },
			{ body: '#070d24', fog: [0.15, 'rgba(20,35,90,.45)'], towers: towers(R, { x0: -0.03, x1: 1.03, minW: 0.05, maxW: 0.1, minH: 0.14, maxH: 0.32, cols: 50, rows: 45, lit: 0.22, strips: 0.35, signs: 0.35, gap: 0.02 }) },
			{ body: '#03060f', fog: null, towers: towers(R, { x0: -0.05, x1: 1.05, minW: 0.07, maxW: 0.14, minH: 0.06, maxH: 0.16, cols: 40, rows: 30, lit: 0.25, strips: 0.4, signs: 0.5, gap: 0.12 }) }
		];
	})();

	var cityCanvas = document.createElement('canvas');
	var cityCtx = cityCanvas.getContext('2d');
	var beaconTips = [];

	// Draws one layer of towers standing on `ground`; collects spire tips
	function drawTowers(c, list, W, H, ground, body) {
		list.forEach(function (t) {
			var x = t.x * W, w = t.w * W, h = t.h * H, top = ground - h;
			c.fillStyle = body;
			c.fillRect(x, top, w, h + 2);
			if (t.step) c.fillRect(x + w * 0.2, top - h * t.step * 0.25, w * 0.6, h * t.step * 0.25 + 1);
			if (t.spire) {
				var sx = x + w / 2, sTop = top - (t.step ? h * t.step * 0.25 : 0) - h * 0.18;
				c.strokeStyle = body;
				c.lineWidth = Math.max(1, w * 0.05);
				c.beginPath(); c.moveTo(sx, top); c.lineTo(sx, sTop); c.stroke();
				beaconTips.push([sx, sTop]);
			}
			var cw = w / t.cols, rh = h / t.rows;
			t.win.forEach(function (wn) {
				c.fillStyle = 'rgba(' + wn[2] + ',' + wn[3] + ')';
				c.fillRect(x + wn[0] * cw + cw * 0.28, top + wn[1] * rh + rh * 0.3, Math.max(1, cw * 0.44), Math.max(1, rh * 0.32));
			});
			c.save();
			c.lineCap = 'round';
			t.strips.forEach(function (s) {
				c.shadowColor = s.col; c.shadowBlur = 5 * dpr;
				c.strokeStyle = s.col; c.lineWidth = Math.max(1.5, w * 0.035);
				c.beginPath(); c.moveTo(x + s.u * w, top + s.v0 * h); c.lineTo(x + s.u * w, top + s.v1 * h); c.stroke();
			});
			t.signs.forEach(function (s) {
				var sw = w * s.sw, sh = h * s.sh, sx2 = x + s.u * w, sy = top + s.v * h;
				c.shadowColor = s.col; c.shadowBlur = 6 * dpr;
				c.fillStyle = 'rgba(5,6,16,.9)'; c.fillRect(sx2, sy, sw, sh);
				c.strokeStyle = s.col; c.lineWidth = 1.5; c.strokeRect(sx2, sy, sw, sh);
				c.shadowBlur = 3 * dpr; c.fillStyle = s.col;
				for (var g = 0; g < 3; g++) c.fillRect(sx2 + sw * (0.1 + g * 0.3), sy + sh * 0.3, sw * 0.2, sh * 0.4);
			});
			c.restore();
		});
	}

	// Sky and city, drawn once per resize. Heights follow the visible area.
	function buildCity(horizon, visibleH) {
		cityCanvas.width = canvas.width;
		cityCanvas.height = canvas.height;
		var c = cityCtx;
		c.setTransform(dpr, 0, 0, dpr, 0, 0);
		beaconTips = [];

		var sky = c.createLinearGradient(0, 0, 0, horizon);
		sky.addColorStop(0, '#02030a');
		sky.addColorStop(0.6, '#060d26');
		sky.addColorStop(1, '#0d1d4a');
		c.fillStyle = sky;
		c.fillRect(0, 0, width, height);
		var glow = c.createRadialGradient(width / 2, horizon, 0, width / 2, horizon, width * 0.6);
		glow.addColorStop(0, 'rgba(110,60,255,.22)');
		glow.addColorStop(1, 'rgba(110,60,255,0)');
		c.fillStyle = glow;
		c.fillRect(0, 0, width, height);

		CITY.forEach(function (layer) {
			drawTowers(c, layer.towers, width, visibleH, horizon, layer.body);
			if (layer.fog) {
				var fh = visibleH * layer.fog[0];
				var f = c.createLinearGradient(0, horizon, 0, horizon - fh);
				f.addColorStop(0, layer.fog[1]);
				f.addColorStop(1, 'rgba(0,0,0,0)');
				c.fillStyle = f;
				c.fillRect(0, horizon - fh, width, fh + 2);
			}
		});
	}

	// Air traffic: light trails crossing between the towers
	var cars = [];
	for (var ci = 0; ci < 6; ci++) {
		cars.push({ x: Math.random(), y: rand(0.12, 0.42), v: rand(0.02, 0.08) * (Math.random() < 0.5 ? -1 : 1), s: rand(0.6, 1.4), col: Math.random() < 0.5 ? '255,90,110' : Math.random() < 0.5 ? '255,240,220' : '120,220,255' });
	}

	function drawTraffic(dt, top, visibleH) {
		cars.forEach(function (car) {
			car.x += car.v * dt;
			if (car.x > 1.1) car.x = -0.1;
			if (car.x < -0.1) car.x = 1.1;
			var x = car.x * width, y = top + car.y * visibleH, len = 30 * car.s, dir = car.v > 0 ? 1 : -1;
			var g = ctx.createLinearGradient(x, y, x - dir * len, y);
			g.addColorStop(0, 'rgba(' + car.col + ',.95)');
			g.addColorStop(1, 'rgba(' + car.col + ',0)');
			ctx.fillStyle = g;
			ctx.fillRect(Math.min(x, x - dir * len), y - car.s, len, car.s * 2);
		});
	}

	function drawBeacons(t) {
		ctx.save();
		ctx.fillStyle = '#ff3b3b';
		ctx.shadowColor = '#ff3b3b';
		ctx.shadowBlur = 8 * dpr;
		beaconTips.forEach(function (p, i) {
			if (((t * 0.8 + i * 0.37) % 1) >= 0.18) return;
			ctx.beginPath(); ctx.arc(p[0], p[1], 1.8, 0, Math.PI * 2); ctx.fill();
		});
		ctx.restore();
	}

	// ---------- Scene ----------

	// Rain: faint streaks that each land somewhere on the street (nearer
	// drops land lower) and leave a ripple where they hit
	var ripples = [];

	function newDrop(d, top) {
		d.x = Math.random() * 1.3 - 0.15;
		d.y = top ? -0.08 : Math.random();
		d.z = Math.random();             // 0 = far, 1 = near
		d.l = rand(0.6, 1.2);
		return d;
	}

	function drawRain(dt, horizon, ground) {
		var slant = 0.12;
		var layers = [[], []];
		for (var i = 0; i < drops.length; i++) {
			var d = drops[i];
			d.y += dt * (0.9 + d.z * 1.4);
			var land = (horizon + (ground - horizon) * (0.04 + 0.96 * d.z * d.z)) / height;
			if (d.y >= land) {
				ripples.push({ x: (d.x + land * slant) * width, y: land * height, z: d.z, age: 0 });
				newDrop(d, true);
				continue;
			}
			layers[d.z > 0.6 ? 1 : 0].push(d);
		}
		[[layers[0], 0.08, 1], [layers[1], 0.16, 1.2]].forEach(function (layer) {
			ctx.beginPath();
			layer[0].forEach(function (d) {
				var len = (height * 0.02 + height * 0.03 * d.z) * d.l;
				var x = (d.x + d.y * slant) * width, y = d.y * height;
				ctx.moveTo(x, y);
				ctx.lineTo(x - slant * len, y - len);
			});
			ctx.strokeStyle = 'rgba(185,205,255,' + layer[1] + ')';
			ctx.lineWidth = layer[2];
			ctx.stroke();
		});
	}

	function drawRipples(dt) {
		ctx.lineWidth = 1;
		for (var i = ripples.length - 1; i >= 0; i--) {
			var r = ripples[i];
			r.age += dt / 0.9;
			if (r.age >= 1) { ripples.splice(i, 1); continue; }
			var rx = (3 + r.age * 22) * (0.35 + r.z);
			ctx.strokeStyle = 'rgba(190,210,255,' + (0.22 * (1 - r.age)) + ')';
			ctx.beginPath();
			ctx.ellipse(r.x, r.y, rx, rx * 0.16, 0, 0, Math.PI * 2);
			ctx.stroke();
		}
	}

	// Where everything goes, from the visible area (inside the overscan)
	function layout() {
		var visibleH = height - 2 * overscan;
		var size = Math.min(width * 0.42, visibleH * 0.4);
		var cy = overscan + visibleH * 0.4;
		return { visibleH: visibleH, size: size, cx: width / 2, cy: cy, horizon: cy + size * 0.72 };
	}

	function draw(t, dt) {
		var L = layout();
		var angle = reduceMotion.matches ? 0.5 : t * SPIN_SPEED;
		var level = neonLevel(t);
		var still = reduceMotion.matches;

		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.globalAlpha = 1;
		ctx.globalCompositeOperation = 'source-over';

		// Sky and city, then the lights that move
		ctx.drawImage(cityCanvas, 0, 0, width, height);
		drawBeacons(t);
		drawTraffic(still ? 0 : dt, overscan, L.visibleH);

		// Pink light the sign throws into the haze
		var light = ctx.createRadialGradient(L.cx, L.cy, 0, L.cx, L.cy, L.size * 1.5);
		light.addColorStop(0, 'rgba(' + NEON_RGB + ',' + 0.18 * level + ')');
		light.addColorStop(1, 'rgba(' + NEON_RGB + ',0)');
		ctx.fillStyle = light;
		ctx.fillRect(0, 0, width, height);

		// Wet street: the city and the sign mirrored, darkening towards the viewer
		ctx.fillStyle = '#03050c';
		ctx.fillRect(0, L.horizon, width, height - L.horizon);
		ctx.save();
		ctx.beginPath();
		ctx.rect(0, L.horizon, width, height - L.horizon);
		ctx.clip();
		ctx.translate(0, L.horizon * 2);
		ctx.scale(1, -1);
		ctx.globalAlpha = 0.35;
		ctx.drawImage(cityCanvas, 0, 0, cityCanvas.width, L.horizon * dpr, 0, 0, width, L.horizon);
		ctx.globalAlpha = 0.3;
		drawSign(L.cx, L.cy, L.size, angle, level, false);
		ctx.restore();
		var fade = ctx.createLinearGradient(0, L.horizon, 0, height - overscan);
		fade.addColorStop(0, 'rgba(3,5,12,0.15)');
		fade.addColorStop(1, 'rgba(3,5,12,0.92)');
		ctx.fillStyle = fade;
		ctx.fillRect(0, L.horizon, width, height - L.horizon);

		drawSign(L.cx, L.cy, L.size, angle, level, true);

		drawRipples(still ? 0 : dt);
		drawRain(still ? 0 : dt, L.horizon, height - overscan);

		// Vignette
		var v = ctx.createRadialGradient(L.cx, L.cy, Math.min(width, L.visibleH) * 0.3, L.cx, L.cy, Math.max(width, L.visibleH) * 0.75);
		v.addColorStop(0, 'rgba(0,0,0,0)');
		v.addColorStop(1, 'rgba(0,0,0,0.6)');
		ctx.fillStyle = v;
		ctx.fillRect(0, 0, width, height);
	}

	// ---------- Setup ----------

	function resize() {
		dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
		overscan = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--overscan')) || 0;
		// Use the canvas's CSS size: on iOS that is the large viewport (under
		// the browser bars), while innerHeight stops short of them
		width = canvas.clientWidth;
		height = canvas.clientHeight;
		canvas.width = layer.width = Math.round(width * dpr);
		canvas.height = layer.height = Math.round(height * dpr);

		// Rain density follows the screen area
		var count = Math.min(260, Math.round((width * height) / 9000));
		while (drops.length < count) drops.push(newDrop({}, false));
		drops.length = count;

		var L = layout();
		buildCity(L.horizon, L.visibleH);
	}

	function frame(now) {
		var dt = Math.min((now - last) / 1000, 0.05);
		last = now;
		draw((now - t0) / 1000, dt);
		if (!reduceMotion.matches) requestAnimationFrame(frame);
	}

	function init() {
		canvas = document.getElementById('scene');
		ctx = canvas.getContext('2d');

		resize();
		last = t0 = performance.now();
		draw(0, 0);
		requestAnimationFrame(frame);

		// Scroll past the top overscan, so iOS Safari draws the page under its
		// bars (see --overscan in style.css). Users can't scroll the page.
		history.scrollRestoration = 'manual';
		function scrollPastOverscan() {
			window.scrollTo(0, overscan);
		}
		scrollPastOverscan();
		window.addEventListener('load', scrollPastOverscan);

		// Redraw whenever the canvas changes size (window resize, rotation).
		// Resizing clears the canvas, so always redraw.
		new ResizeObserver(function () {
			resize();
			draw((performance.now() - t0) / 1000, 0);
			scrollPastOverscan();
		}).observe(canvas);

		// Restart the loop if the user turns reduced motion off
		reduceMotion.addEventListener('change', function () {
			if (!reduceMotion.matches) {
				last = performance.now();
				requestAnimationFrame(frame);
			} else {
				draw((performance.now() - t0) / 1000, 0);
			}
		});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
