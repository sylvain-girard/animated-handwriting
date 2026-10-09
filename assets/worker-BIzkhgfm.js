(function(){"use strict";function J(e=""){return`/animated-handwriting/${e.replace(/^\/+/,"")}`}var le=`import io
import json
import re
import time
from pathlib import Path
from types import SimpleNamespace
from array import array
from fontTools.fontBuilder import FontBuilder
from fontTools.ttLib import TTFont, newTable
from fontTools.ttLib.tables._g_l_y_f import Glyph, GlyphCoordinates
from fontTools.designspaceLib import DesignSpaceDocument, AxisDescriptor, SourceDescriptor
from fontTools.feaLib.builder import addOpenTypeFeaturesFromString
from fontTools.varLib import build
from fontTools.pens.recordingPen import RecordingPointPen
from fontTools.ttLib.tables.TupleVariation import TupleVariation
from fontTools.ttLib import woff2 as woff2_module


def make_glyph(contours):
    glyph = Glyph()
    glyph.numberOfContours = len(contours)
    if contours:
        coords = []
        ends = []
        for contour in contours:
            coords.extend((round(p[0]), round(p[1])) for p in contour)
            ends.append(len(coords) - 1)
        glyph.coordinates = GlyphCoordinates(coords)
        glyph.endPtsOfContours = ends
        glyph.flags = array('B', [1] * len(coords))
        from fontTools.ttLib.tables.ttProgram import Program
        glyph.program = Program()
        glyph.program.fromBytecode([])
    return glyph


_font_state = None


def start_font(header):
    """Build shared default tables without retaining any sampled masters."""
    global _font_state
    started = time.perf_counter()
    _font_state = None
    names = header['glyphNames']
    widths = header['advances']
    cmap = {int(k): v for k, v in header['cmap'].items()}
    metrics = header['metrics']
    family = header['familyName']
    feature = header['feature']
    # PostScript names must be ASCII and cannot contain whitespace or the
    # reserved delimiters. Keep the suffix inside the 63-character limit.
    ps_family = re.sub(r'[^A-Za-z0-9-]', '', family.encode('ascii', 'ignore').decode()) or 'Handwriting'
    ps_name = ps_family[:55] + '-Regular'
    notdef = [[[50, 0], [50, 600], [450, 600], [450, 0]], [[100, 50], [400, 50], [400, 550], [100, 550]]]

    def source_font(outlines, weight=400, include_features=False):
        fb = FontBuilder(metrics['unitsPerEm'], isTTF=True)
        order = list(outlines)
        fb.setupGlyphOrder(order)
        fb.setupCharacterMap({code: name for code, name in cmap.items() if name in outlines})
        outlines = {name: make_glyph(contours) for name, contours in outlines.items()}
        fb.setupGlyf(outlines)
        # xMin - LSB is the left phantom point. Keep it at zero, rather than
        # freezing LSB while the visible glyph's bounding box changes.
        fb.setupHorizontalMetrics({name: (widths[name], getattr(outlines[name], 'xMin', 0)) for name in order})
        fb.setupHorizontalHeader(ascent=metrics['ascender'], descent=metrics['descender'], lineGap=200)
        fb.setupNameTable({'familyName': family, 'styleName': 'Regular', 'uniqueFontIdentifier': family + '-Regular',
                          'fullName': family, 'psName': ps_name, 'version': 'Version 0.100'})
        fb.setupOS2(sTypoAscender=metrics['ascender'], sTypoDescender=metrics['descender'], sTypoLineGap=200,
                    usWinAscent=1000, usWinDescent=400, sxHeight=metrics['xHeight'], sCapHeight=metrics['capHeight'],
                    usWeightClass=int(weight), fsSelection=0xC0, version=4)
        fb.setupPost()
        fb.setupMaxp()
        if include_features and feature:
            addOpenTypeFeaturesFromString(fb.font, feature)
        fb.font['head'].flags |= 2
        return fb.font

    default_outlines = {'.notdef': notdef}
    default_outlines.update(header['defaultOutlines'])
    font = source_font(default_outlines, include_features=True)
    engine = header.get('engine')
    if engine != 'static':
        font['gvar'] = newTable('gvar')
        font['gvar'].version = 1
        font['gvar'].reserved = 0
        font['gvar'].variations = {'.notdef': []}
    if engine not in ('varlib', 'static'):
        builder = FontBuilder(font=font)
        builder.setupFvar([('DRAW', 0, 1000, 1000, 'Drawing progress'), ('wght', 100, 400, 900, 'Weight')], [])
        builder.setupStat([{'tag': 'DRAW', 'name': 'Drawing progress'}, {'tag': 'wght', 'name': 'Weight'}])
    _font_state = SimpleNamespace(font=font, names=names, source_font=source_font,
        notdef=notdef, engine=engine, assembly_seconds=time.perf_counter() - started)


def add_glyph(model):
    """Consume one glyph's compatible masters and keep only its gvar tuples."""
    global _font_state
    try:
        _add_glyph(model)
    except Exception:
        _font_state = None
        raise


def _add_glyph(model):
    started = time.perf_counter()
    state = _font_state
    if state is None:
        raise ValueError('start_font must be called before add_glyph')
    font = state.font
    name = model['name']
    if not model['masters']:
        font['gvar'].variations[name] = []
    elif state.engine == 'varlib':
        # Every glyph has its own DRAW support grid. Build its compatible masters
        # with varLib, then retain its gvar data in the shared font. There are no
        # variable advances or composites, so no per-glyph HVAR stores to merge.
        design = DesignSpaceDocument()
        for tag, minimum, default, maximum in [('DRAW', 0, 1000, 1000), ('wght', 100, 400, 900)]:
            axis = AxisDescriptor()
            axis.name = axis.tag = tag
            axis.minimum, axis.default, axis.maximum = minimum, default, maximum
            design.addAxis(axis)
        for index, master in enumerate(model['masters']):
            source = SourceDescriptor()
            source.name = f"{name}-{index}"
            source.location = {'DRAW': master['draw'], 'wght': master['weight']}
            source.font = state.source_font({'.notdef': state.notdef, name: master['contours']}, master['weight'])
            if master['draw'] == 1000 and master['weight'] == 400:
                source.copyInfo = source.copyLib = source.copyFeatures = True
            design.addSource(source)
        # Pure-Python IUP delta optimization is prohibitively slow in WASM on
        # dense animated outlines. Preserve explicit deltas; Brotli still
        # compresses the web font. This also makes collapsed points explicit.
        variable, _, _ = build(design, optimize=False)
        if 'fvar' not in font:
            font['fvar'] = variable['fvar']
            font['name'] = variable['name']
            if 'STAT' in variable:
                font['STAT'] = variable['STAT']
        font['gvar'].variations[name] = variable['gvar'].variations[name]
    else:
        def coordinates(contours):
            # Four explicit zero phantom deltas preserve origin and advances.
            return [(round(p[0]), round(p[1])) for c in contours for p in c] + [(0, 0)] * 4

        def subtract(a, b):
            return [(p[0] - q[0], p[1] - q[1]) for p, q in zip(a, b)]

        states = {(m['draw'], m['weight']): coordinates(m['contours']) for m in model['masters']}
        positions = sorted(set(m['draw'] for m in model['masters']))
        default = states[(1000, 400)]
        tuples = []
        weights = [(100, (-1, -1, 0)), (900, (0, 1, 1))]
        weight_deltas = {weight: subtract(states[(1000, weight)], default) for weight, _ in weights}
        for weight, support in weights:
            tuples.append(TupleVariation({'wght': support}, weight_deltas[weight]))
        # Piecewise-linear hat functions partition DRAW. The fully-drawn
        # default contributes the baseline; the other hats carry offsets.
        # Weight is linear on each side of 400, so cross tuples are exact
        # bilinear corrections (apart from integer coordinate rounding).
        for index, draw in enumerate(positions[:-1]):
            peak = (draw - 1000) / 1000
            start = (positions[max(0, index - 1)] - 1000) / 1000
            end = (positions[index + 1] - 1000) / 1000
            support = (start, peak, end)
            regular = states[(draw, 400)]
            tuples.append(TupleVariation({'DRAW': support}, subtract(regular, default)))
            for weight, weight_support in weights:
                delta = subtract(subtract(states[(draw, weight)], regular), weight_deltas[weight])
                if any(x or y for x, y in delta):
                    tuples.append(TupleVariation({'DRAW': support, 'wght': weight_support}, delta))
        font['gvar'].variations[name] = tuples
    state.assembly_seconds += time.perf_counter() - started


def finish_font(probes):
    """Encode and verify the assembled font against the exact source probes."""
    global _font_state
    try:
        _finish_font(probes)
    finally:
        _font_state = None


def _finish_font(probes):
    global _font_state
    started = time.perf_counter()
    state = _font_state
    if state is None:
        raise ValueError('start_font must be called before finish_font')
    font = state.font
    names = state.names
    prior_assembly = state.assembly_seconds
    is_static = state.engine == 'static'
    if not is_static and 'fvar' not in font:
        raise ValueError('At least one drawn glyph is required')
    font['head'].created = 3874003200
    font['head'].modified = 3874003200
    font.recalcTimestamp = False
    outlines_done = time.perf_counter()
    ttf_file = io.BytesIO()
    font.save(ttf_file)
    ttf = ttf_file.getvalue()
    ttf_file.close()
    ttf_done = time.perf_counter()
    font.flavor = 'woff2'
    woff_file = io.BytesIO()
    # FontTools defaults to Brotli quality 11, which favours the smallest file
    # over interactive export time. Quality 6 is still lossless WOFF2. Scope
    # the adapter to this save and restore the module even if compression fails.
    original_brotli = woff2_module.brotli
    woff2_module.brotli = SimpleNamespace(MODE_FONT=original_brotli.MODE_FONT,
        compress=lambda data, **kwargs: original_brotli.compress(data, quality=6, **kwargs))
    try:
        font.save(woff_file)
    finally:
        woff2_module.brotli = original_brotli
    woff2 = woff_file.getvalue()
    woff_file.close()
    # gvar coordinates are much larger than the encoded files. Release the
    # original font before WOFF2 decoding creates another set for validation.
    font.close()
    _font_state = None
    del state, font
    woff2_done = time.perf_counter()
    restored = TTFont(io.BytesIO(woff2))
    axis_ok = is_static and 'fvar' not in restored or not is_static and [(a.axisTag, a.minValue, a.defaultValue, a.maxValue) for a in restored['fvar'].axes] == [('DRAW', 0, 1000, 1000), ('wght', 100, 400, 900)]
    checks = [{'name': 'Static font has no animation tables' if is_static else 'Required axes and defaults survive WOFF2', 'passed': axis_ok and ('gvar' not in restored if is_static else True), 'detail': 'Completed regular-weight outlines' if is_static else 'DRAW 0/1000/1000; wght 100/400/900'}]
    expected_widths = {name: restored['hmtx'][name][0] for name in names}
    stable_widths = True
    blank = True
    max_outline_error = 0
    probes = probes + ([] if is_static else [
        {'draw': 0, 'weight': weight, 'outlines': {}} for weight in [100, 900]
    ])
    for probe in probes:
        glyph_set = restored.getGlyphSet(location=None if is_static else {'DRAW': probe['draw'], 'wght': probe['weight']})
        for name in names:
            pen = RecordingPointPen()
            item = glyph_set[name]
            item.drawPoints(pen)
            coords = [args[0] for op, args, kwargs in pen.value if op == 'addPoint']
            stable_widths &= abs(item.width - expected_widths[name]) <= 1
            expected_contours = probe['outlines'].get(name)
            if expected_contours is not None:
                expected = [p for contour in expected_contours for p in contour]
                if len(expected) != len(coords):
                    raise ValueError(f"{name}: exported outline topology changed")
                for p, q in zip(coords, expected):
                    max_outline_error = max(max_outline_error, ((p[0]-q[0])**2 + (p[1]-q[1])**2)**0.5)
            if name != '.notdef' and probe['draw'] == 0:
                contour = []
                for op, args, kwargs in pen.value:
                    if op == 'beginPath':
                        contour = []
                    elif op == 'addPoint':
                        contour.append(args[0])
                    elif op == 'endPath':
                        blank &= len(set(contour)) <= 1
    checks.extend([
        {'name': 'Compiled advance widths stay fixed', 'passed': bool(stable_widths), 'detail': 'WOFF2 glyph-set evaluation at endpoint and intermediate axis positions'},
        {'name': 'Compiled outlines match source including origins', 'passed': max_outline_error <= 4, 'detail': f"{max_outline_error:.2f} font units max error after WOFF2 round trip"},
        {'name': 'Compiled DRAW 0 contours collapse', 'passed': bool(blank), 'detail': 'Every non-.notdef contour collapses to a single coordinate at 100, 650, 900'},
    ])
    if is_static:
        checks = [check for check in checks if check['name'] != 'Compiled DRAW 0 contours collapse']
    restored.close()
    Path('/tmp/handwriting.ttf').write_bytes(ttf)
    Path('/tmp/handwriting.woff2').write_bytes(woff2)
    finished = time.perf_counter()
    Path('/tmp/handwriting-report.json').write_text(json.dumps({'assemblyMs': (prior_assembly + finished - started) * 1000, 'checks': checks,
        'stageMs': {'fontAssembly': (prior_assembly + outlines_done - started) * 1000, 'ttfEncoding': (ttf_done - outlines_done) * 1000,
                    'woff2Encoding': (woff2_done - ttf_done) * 1000, 'roundTripValidation': (finished - woff2_done) * 1000}}))


def build_font(payload):
    """Compatibility wrapper for callers that already hold a full payload."""
    header = {key: payload[key] for key in ('glyphNames', 'advances', 'cmap', 'metrics', 'familyName', 'feature')}
    header['engine'] = payload.get('engine')
    header['defaultOutlines'] = {model['name']: model['defaultContours'] for model in payload['glyphModels']}
    start_font(header)
    for model in payload['glyphModels']:
        add_glyph(model)
    finish_font(payload['probes'])
`;const ce=e=>/^[a-zA-Z]+$/.test(e);function fe(e){return(e.font.variants??[]).map(n=>n.rule)}function I(e){return[...e.font.glyphs,...e.font.ligatures,...e.font.variants??[]]}function O(e,n){return e.font.variants?.find(t=>t.text===n)?.rule.source??n}function Q(e){const n=e.font.variants??[],t=[...new Set(n.map(s=>s.rule.source))];return Object.fromEntries(n.map(s=>[s.text,{source:s.rule.source,tag:`cv${String(t.indexOf(s.rule.source)+1).padStart(2,"0")}`,value:n.filter(a=>a.rule.source===s.rule.source).indexOf(s)+1}]))}const de=e=>Math.max(0,Math.min(1,e.speedInfluence??.7));function ue(e){let n=null;return e.samples.map(t=>e.pointerType!=="pen"&&e.pointerType!=="fixture"?null:(t.contact===!1||(n=t.pressure),n))}function me(e){const n=[];let t,s=0,a=e.samples[0]?.time??0,l=1;const o=Number.isFinite(e.speedScale)&&e.speedScale>0?e.speedScale:1;return e.samples.forEach((c,m)=>{if(!m){n.push(l);return}const r=e.samples[m-1],u=Math.hypot(c.x-r.x,c.y-r.y)*o;s+=u;const f=c.time-a;if(f>0){if(s>.01){const p=s/f,g=t===void 0;t=g?p:t+(p-t)*(1-Math.exp(-f/40)),l=.45+1.1/(1+Math.pow(t/1.2,1.15)),g&&n.fill(l)}s=0,a=c.time}n.push(l)}),n}const pe=3,he=12,$=(e,n=0,t=1)=>Math.max(n,Math.min(t,e)),S=(e,n,t)=>e+(n-e)*t;function ge(e,n){if(!e.samples.length)throw new Error(`Stroke ${e.id} has no samples`);for(let i=0;i<e.samples.length;i++){const d=e.samples[i];if(![d.x,d.y,d.time].every(Number.isFinite)||d.pressure!==null&&(!Number.isFinite(d.pressure)||d.pressure<0||d.pressure>1)||d.contact!==void 0&&typeof d.contact!="boolean")throw new Error(`Stroke ${e.id} contains invalid samples`);if(i&&d.time<e.samples[i-1].time)throw new Error(`Stroke ${e.id} has non-monotonic time`)}const t=$(n.smoothing),s=e.samples,a=ue(e),l=n.speedEnabled?me(e):s.map(()=>1),o=s.map((i,d)=>d===0||d===s.length-1||i.x===s[d-1].x&&i.y===s[d-1].y||i.x===s[d+1].x&&i.y===s[d+1].y?{...i}:{...i,x:S(i.x,(s[d-1].x+2*i.x+s[d+1].x)/4,t),y:S(i.y,(s[d-1].y+2*i.y+s[d+1].y)/4,t)}),c=[0];for(let i=1;i<o.length;i++)c.push(c[i-1]+Math.hypot(o[i].x-o[i-1].x,o[i].y-o[i-1].y));const m=c.at(-1),r=m<2,u=r?a.reduce((i,d)=>d===null?i:Math.max(i??0,d),null):null,f=s[0].time,p=Math.max(f+40,s.at(-1).time),g=r?1:Math.max(2,Math.ceil(m/he)+1),h=Array.from({length:g},(i,d)=>{const v=r?0:m*d/(g-1);let _=1;for(;_<c.length-1&&c[_]<v;)_++;const w=Math.max(0,_-1),x=Math.min(_,o.length-1),M=$((v-c[w])/(c[x]-c[w]||1)),T=o[w],F=o[x],y=a[w],b=a[x],A=r?u:y===null||b===null?null:S(y,b,M);return{id:`${e.id}:${pe}:${d}`,x:S(T.x,F.x,M),y:S(T.y,F.y,M),time:S(T.time,F.time,M),pressure:A,speedWidth:r?1:S(l[w],l[x],M),distance:v,tangent:{x:1,y:0},normal:{x:0,y:1}}});for(let i=0;i<h.length;i++){const d=h[Math.max(0,i-1)],v=h[Math.min(h.length-1,i+1)],_=v.x-d.x,w=v.y-d.y,x=Math.hypot(_,w);h[i].tangent=x>1e-8?{x:_/x,y:w/x}:{x:1,y:0},h[i].normal={x:-h[i].tangent.y,y:h[i].tangent.x}}return{id:e.id,points:h,length:m,progressLength:r?n.baseStrokeWidth:m,dot:r,startTime:f,endTime:p,timing:o.map((i,d)=>({time:i.time,distance:c[d]}))}}function ye(e,n){const t=e.strokes.map(o=>ge({...o,speedScale:(o.speedScale??1)/e.transform.scale,samples:o.samples.map(c=>({...c,x:c.x*e.transform.scale+e.transform.x,y:c.y*e.transform.scale+e.transform.y}))},n));let s=0;const a=t.reduce((o,c)=>o+c.progressLength,0),l=t.map(o=>{const c=s/a*1e3;return s+=o.progressLength,{startDraw:c,endDraw:s/a*1e3}});return{...e,processed:t,intervals:l}}function we(e,n){if(e.dot)return e.points[0];const t=$(n/e.length)*(e.points.length-1),s=Math.min(Math.floor(t),e.points.length-2),a=t-s,l=e.points[s],o=e.points[s+1],c=Math.atan2(l.tangent.y,l.tangent.x),m=Math.atan2(o.tangent.y,o.tangent.x),r=Math.atan2(Math.sin(m-c),Math.cos(m-c)),u=c+r*a;return{x:S(l.x,o.x,a),y:S(l.y,o.y,a),time:S(l.time,o.time,a),pressure:l.pressure===null||o.pressure===null?null:S(l.pressure,o.pressure,a),speedWidth:S(l.speedWidth,o.speedWidth,a),tangent:{x:Math.cos(u),y:Math.sin(u)}}}const K=12;function xe(e){return e<=400?S(.5,1,$((e-100)/300)):S(1,2,$((e-400)/500))}function R(e,n,t,s=1){const a=t.speedEnabled?S(1,s,de(t)):t.pressureEnabled&&e!==null?S(1,.25+1.5*e,t.pressureInfluence):1;return t.baseStrokeWidth*xe(n)*a/2}function q(e,n,t,s){const a={x:-n.y,y:n.x};return Array.from({length:K+1},(l,o)=>{const c=o/K;let m,r;return s==="round"?(m=Math.sin(c*Math.PI),r=Math.cos(c*Math.PI)):c<=1/3?(m=c*3,r=1):c<=2/3?(m=1,r=1-(c-1/3)*6):(m=(1-c)*3,r=-1),{x:e.x+t*(n.x*m+a.x*r),y:e.y+t*(n.y*m+a.y*r)}})}function be(e,n,t,s){const a=$(n),l=e.points[0];if(e.dot){const p=R(l.pressure,t,s,l.speedWidth)*a,g=q(l,{x:1,y:0},p,s.capStyle),h=q(l,{x:-1,y:0},p,s.capStyle);return[...g,...h]}const o=e.points.length*2+2*(K+1);if(a===0)return Array.from({length:o},()=>({x:l.x,y:l.y}));const c=e.length*a,m=we(e,c),r=$(c),u=[],f=[];for(const p of e.points){const g=p.distance<=c?p:m,h=R(g.pressure,t,s,g.speedWidth)*r,i=-g.tangent.y,d=g.tangent.x;u.push({x:g.x+i*h,y:g.y+d*h}),f.push({x:g.x-i*h,y:g.y-d*h})}return[...u,...q(m,m.tangent,R(m.pressure,t,s,m.speedWidth)*r,s.capStyle),...f.reverse(),...q(l,{x:-l.tangent.x,y:-l.tangent.y},R(l.pressure,t,s,l.speedWidth)*r,s.capStyle)]}function k(e,n,t,s){return e.processed.map((a,l)=>{const o=e.intervals[l];return be(a,(n-o.startDraw)/(o.endDraw-o.startDraw),t,s)})}const z=e=>Math.round($(e/1e3)*16384)/16384*1e3;function _e(e){return{...e,intervals:e.intervals.map(n=>({startDraw:z(n.startDraw),endDraw:z(n.endDraw)}))}}function ve(e,n){const t=new Set(Array.from({length:n},(s,a)=>z(a*1e3/(n-1))));for(const s of e)for(let a=0;a<s.intervals.length;a++){const l=s.intervals[a];t.add(l.startDraw),t.add(l.endDraw);const o=s.processed[a];o.dot||t.add(z(l.startDraw+(l.endDraw-l.startDraw)/o.length))}return[...t].sort((s,a)=>s-a)}function Me(e){return e.reduce((n,t,s)=>{const a=e[(s+1)%e.length];return n+t.x*a.y-a.x*t.y},0)/2}function Se(e,n,t,s=2){const a=new Set(t),l=r=>e.map(u=>k(u,r,900,n)),o=new Map,c=r=>{let u=o.get(r);return u||(u=l(r),o.set(r,u)),u};function m(r,u,f){if(f>12||a.size>=512||u-r<=1e3/16384)return;const p=z((r+u)/2);if(p<=r||p>=u)return;const g=c(r),h=c(u);let i=0;for(const d of[.25,.5,.75]){const v=r+(u-r)*d,_=c(v);for(let w=0;w<g.length;w++)for(let x=0;x<g[w].length;x++)for(let M=0;M<g[w][x].length;M++){const T=g[w][x][M],F=h[w][x][M],y=_[w][x][M];i=Math.max(i,Math.hypot(S(T.x,F.x,d)-y.x,S(T.y,F.y,d)-y.y))}}i>s&&(a.add(p),m(r,p,f+1),m(p,u,f+1))}for(let r=0;r<t.length-1;r++)m(t[r],t[r+1],0);return[...a].sort((r,u)=>r-u)}function Te(e){return e.font.spacing??{mode:"auto",gap:80}}function Z(e,n){const t=ye(e,n.settings),s=Te(n);if(s.mode==="manual"||!t.processed.length||/^\s+$/.test(e.text))return t;let a=1/0,l=-1/0;for(const r of k(t,1e3,400,n.settings))for(const u of r)a=Math.min(a,u.x),l=Math.max(l,u.x);if(!Number.isFinite(a)||!Number.isFinite(l))return t;const o=s.gap/2+(e.spacing?.left??0),c=s.gap/2+(e.spacing?.right??0),m=o-a;return{...t,advanceWidth:Math.max(1,Math.round(l-a+o+c)),processed:t.processed.map(r=>({...r,points:r.points.map(u=>({...u,x:u.x+m}))}))}}const X=new WeakMap;function Y(e,n){let t=X.get(e);return t||(t=new Map,X.set(e,t)),t.has(n.text)||t.set(n.text,Z(n,e)),t.get(n.text)}function j(e,n){const t=n&&e.processed[n.stroke];return t?n.edge==="start"?t.points[0]:t.points.at(-1):void 0}function Ae(e,n,t){const s={status:"none",adjustment:0};if(e.font.spacing?.mode==="manual"||e.font.spacing?.preserveJoins===!1)return s;const a=I(e),l=a.find(g=>g.text===n),o=a.find(g=>g.text===t);if(!l?.joins?.exit||!o?.joins?.entry||!l.joins.exit.peers.includes(O(e,t))||!o.joins.entry.peers.includes(O(e,n)))return s;const c=Y(e,l),m=Y(e,o),r=j(c,l.joins.exit),u=j(m,o.joins.entry);if(!r||!u)return s;const f=Math.min(R(r.pressure,100,e.settings,r.speedWidth),R(u.pressure,100,e.settings,u.speedWidth))*.7,p=Math.round(r.x-c.advanceWidth-u.x);return Math.abs(r.y-u.y)+1>f||c.advanceWidth+p<=1?{status:"misaligned",adjustment:0}:{status:"joined",adjustment:p}}const G=(e,n,t)=>Math.max(n,Math.min(t,e)),V=e=>{const n=[...e].sort((t,s)=>t-s);return n.length?(n[Math.floor((n.length-1)/2)]+n[Math.floor(n.length/2)])/2:0},ee=new WeakMap;function De(e,n){let t=ee.get(e.font.glyphs);t||(t=new WeakMap,ee.set(e.font.glyphs,t));let s=t.get(e.settings);s||(s=new Map,t.set(e.settings,s));const a=s.get(n);if(a)return a;const l=[...new Set(n)].map(r=>{const u=e.font.glyphs.find(f=>f.text===r);return u&&[r,u.transform,u.strokes.map(f=>[f.pointerType,...e.settings.speedEnabled?[f.speedScale]:[],f.samples.map(p=>[p.x,p.y,p.pressure,p.contact,...e.settings.speedEnabled?[p.time]:[]])])]}),o=JSON.stringify([1,e.settings,l]);let c=2166136261;for(let r=0;r<o.length;r++)c=Math.imul(c^o.charCodeAt(r),16777619);const m=(c>>>0).toString(16);return s.set(n,m),m}const B=(e,n)=>`${e}${n}`,te=new WeakMap;function Fe(e){const n=te.get(e.font);if(n?.settings===e.settings)return n.model;const t=e.font.calibration?.enabled?e.font.calibration.samples:[],s=new Map;let a=0,l=0;for(const f of t){const p=f.analysis;if(p){if(p.signature!==De(e,f.word)){l++;continue}p.observations.length&&a++;for(const g of new Set(p.observations.map(h=>B(h.left,h.right)))){const h=p.observations.filter(d=>B(d.left,d.right)===g),i={...h[0],delta:V(h.map(d=>d.delta)),confidence:Math.min(...h.map(d=>d.confidence))};s.set(g,[...s.get(g)??[],i])}}}const o=(f,p,g)=>{if(!f.length)return p;const h=V(f.map(_=>_.delta)),i=Math.max(18,V(f.map(_=>Math.abs(_.delta-h)))*2.5),d=f.filter(_=>Math.abs(_.delta-h)<=i),v=d.reduce((_,w)=>_+w.confidence,0);return(d.reduce((_,w)=>_+w.delta*w.confidence,0)+p*g)/(v+g)};for(const f of e.font.learning?.samples??[]){const p=f.analysis?.observations??[];for(const g of new Set(p.map(h=>B(h.left,h.right)))){const h=p.filter(i=>B(i.left,i.right)===g);s.set(g,[...s.get(g)??[],{...h[0],delta:V(h.map(i=>i.delta)),confidence:Math.min(...h.map(i=>i.confidence))}])}}const c=[...s.values()].map(f=>({...f[0],delta:o(f,0,0),confidence:Math.min(1,f.reduce((p,g)=>p+g.confidence,0))})),m=s.size>=3?G(o(c,0,8),-80,100):0,r=Object.fromEntries([...s].map(([f,p])=>[f,G(o(p,m,1.5),-140,180)])),u={global:m,pairs:r,examples:a,relationships:s.size,stale:l};return te.set(e.font,{settings:e.settings,model:u}),u}function Ne(e,n,t,s=700){const a=Ae(e,n,t);if(a.status==="joined")return a.adjustment;const l=e.font.calibration;if((!l?.enabled||!l.samples.length)&&!e.font.learning?.samples.length||e.font.spacing?.mode==="manual")return 0;const o=O(e,n),c=O(e,t);if(!/^[a-zA-Z0-9]+$/.test(o)||!/^[a-zA-Z0-9]+$/.test(c))return 0;const m=I(e);if(!m.some(f=>f.text===n&&f.strokes.length)||!m.some(f=>f.text===t&&f.strokes.length))return 0;const r=Fe(e),u=r.pairs[B(o.at(-1),c[0])]??r.global;return Math.round(G(u*G(l?.strength??1,0,1),-s*.4,180))||0}function ne(e){if((!e.font.calibration?.enabled||!e.font.calibration.samples.length)&&!e.font.learning?.samples.length||e.font.spacing?.mode==="manual")return{};const n=I(e).filter(s=>s.strokes.length&&/^[a-zA-Z0-9]+$/.test(O(e,s.text))),t={};for(const s of n){const a=Z(s,e).advanceWidth;for(const l of n){const o=Ne(e,s.text,l.text,a);o&&((t[s.text]??={})[l.text]=o)}}return t}function We(e){const n=I(e),t=new Map(n.map(o=>[o.text,o.glyphName])),s=[],a=e.font.ligatures.filter(o=>o.strokes.length);if(a.length&&s.push(`feature liga {
${[...a].sort((o,c)=>c.text.length-o.text.length||o.text.localeCompare(c.text)).map(o=>`sub ${[...o.text].map(m=>{const r=t.get(m);if(!r)throw new Error(`Ligature ${o.text} needs a source character for ${m}`);return r}).join(" ")} by ${o.glyphName};`).join(`
`)}
} liga;`),e.font.variants?.length){const o=Q(e);for(const r of new Set(e.font.variants.map(u=>u.rule.source))){const u=e.font.variants.filter(p=>p.rule.source===r),f=o[u[0].text].tag;s.push(`feature ${f} { sub ${t.get(r)} from [${u.map(p=>p.glyphName).join(" ")}]; } ${f};`)}const c=n.filter(r=>ce(r.text)||e.font.variants?.includes(r));s.push(`@WordLetters = [${c.map(r=>r.glyphName).join(" ")}];`);for(const r of e.font.glyphs)s.push(`@ctx_${r.glyphName} = [${[r.glyphName,...e.font.variants.filter(u=>u.rule.source===r.text).map(u=>u.glyphName)].join(" ")}];`);const m=e.font.variants.map((r,u)=>{const f=r.rule,p=t.get(f.source),g=d=>`@ctx_${t.get(d)}`,h=[f.left===""?`ignore sub @WordLetters ${p}';`:"",f.right===""?`ignore sub ${p}' @WordLetters;`:""].filter(Boolean).join(`
`),i=[f.left?g(f.left):"",`${p}'`,f.right?g(f.right):""].filter(Boolean).join(" ");return`lookup Context${u} {
${h}
sub ${i} by ${r.glyphName};
} Context${u};`});s.push(`feature calt {
${m.join(`
`)}
} calt;`)}const l=Object.entries(ne(e)).flatMap(([o,c])=>Object.entries(c).map(([m,r])=>`pos ${t.get(o)} ${t.get(m)} ${r};`));return l.length&&s.push(`feature kern {
${l.join(`
`)}
} kern;`),s.join(`
`)}const Ee=()=>[0,.25,.5,.75,1].map(e=>({source:e,time:e}));function ke(e){if(e===void 0)return;const n=e;if(!n||!["recorded","linear","ease-in-out"].includes(n.curve)||!Array.isArray(n.knots)||n.knots.length<2||n.knots.length>64)throw new Error("Invalid timing curve.");if(n.knots.forEach((t,s)=>{if(!t||!Number.isFinite(t.source)||!Number.isFinite(t.time)||t.source<0||t.source>1||t.time<0||t.time>1||s>0&&(t.source<=n.knots[s-1].source||t.time<=n.knots[s-1].time))throw new Error("Timing must move forward.")}),n.knots[0].source!==0||n.knots[0].time!==0||n.knots.at(-1).source!==1||n.knots.at(-1).time!==1)throw new Error("Timing endpoints must stay fixed.")}function se(e,n){if(!e.length)return 0;if(n<e[0].time)return e[0].draw;let t=e[0];for(const s of e.slice(1)){if(s.time>n)return S(t.draw,s.draw,$((n-t.time)/(s.time-t.time||1)));t=s}return t.draw}function oe(e,n,t="first"){const s=e.filter(a=>Math.abs(a.draw-n)<1e-8);if(s.length)return(t==="first"?s[0]:s.at(-1)).time;for(let a=1;a<e.length;a++){const l=e[a-1],o=e[a];if(l.draw<n&&o.draw>n)return S(l.time,o.time,(n-l.draw)/(o.draw-l.draw))}return n<=0?0:e.at(-1)?.time??0}function Pe(e,n){return n==="recorded"?e:n==="linear"?[{time:0,draw:0},{time:1,draw:1e3}]:Array.from({length:65},(t,s)=>{const a=s/64;return{time:a,draw:1e3*a*a*(3-2*a)}})}function $e(e,n){return se(n.map(t=>({time:t.source,draw:t.time})),e)}function Ce(e,n,t,s){if(ke(t),s!=null&&(!Number.isFinite(s)||s<=0))throw new Error("Playback duration must be positive.");if(!e.length)return{duration:0,recordedDuration:0,timeline:[],recorded:[],boundaries:[]};const a=e[0].startTime,l=Math.max(1,e.at(-1).endTime-a),o=[{time:0,draw:0}];e.forEach((i,d)=>{const{startDraw:v,endDraw:_}=n[d],w=Math.min(i.endTime,e[d+1]?.startTime??1/0);o.push({time:i.startTime-a,draw:v}),i.dot||i.timing.forEach(x=>o.push({time:x.time-a,draw:S(v,_,x.distance/(i.length||1))})),o.push({time:w-a,draw:_})}),o.sort((i,d)=>i.time-d.time||i.draw-d.draw);let c=0;const m=o.map(i=>(c=Math.max(c,i.draw),{time:$(i.time/l),draw:c})),r=s??l,u=Pe(m,t?.curve??"recorded"),f=t?.knots??Ee(),g=[...u,...f.map(i=>({time:i.source,draw:se(u,i.source)}))].sort((i,d)=>i.time-d.time||i.draw-d.draw).map(i=>({time:$e(i.time,f)*r,draw:i.draw})),h=n.map(({startDraw:i,endDraw:d})=>({draw:i,startTime:oe(g,i,"last"),endTime:oe(g,d,"first")}));return{duration:r,recordedDuration:l,timeline:g,recorded:m,boundaries:h}}function Oe(e,n){const t=Ce(e.processed,e.intervals,e.timing,n);return{glyphName:e.glyphName,text:e.text,advanceWidth:e.advanceWidth,duration:t.duration,drawDistance:e.processed.reduce((s,a)=>s+a.progressLength,0),timeline:t.timeline,strokes:e.processed.map((s,a)=>({...e.intervals[a],startTime:t.boundaries[a].startTime,endTime:t.boundaries[a].endTime}))}}function Re(e,n,t=ne(e)){return{version:1,familyName:e.font.familyName,sourceRevision:e.revision,sequential:e.playback?.sequential??!0,variantRules:fe(e),variantFeatures:Q(e),unitsPerEm:e.font.metrics.unitsPerEm,kerning:t,glyphs:Object.fromEntries(n.map(s=>[s.text,Oe(s,e.playback?.durationMs==null?null:e.playback.durationMs*[...O(e,s.text)].length)])),ligatures:e.font.ligatures.filter(s=>s.strokes.length).map(s=>s.text).sort((s,a)=>a.length-s.length||s.localeCompare(a)),interTokenPause:e.playback?.letterGapMs??80,spaceDuration:180,constantPenSpeed:800}}function Le(e,n,t,s){let a=!0,l=!0,o=!0,c=!0,m=!0,r=0,u="";const f=[100,237,400,650,900];for(const[g,h]of e.entries()){const i=s?.[g]??t,d=k(h,1e3,400,n);for(const v of f){const _=k(h,0,v,n);l&&=_.every(w=>Math.abs(Me(w))<1e-8&&w.every(x=>x.x===w[0].x&&x.y===w[0].y)),h.intervals.forEach((w,x)=>{const M=k(h,w.startDraw,v,n)[x];o&&=M.every(T=>T.x===M[0].x&&T.y===M[0].y)});for(let w=0;w<i.length-1;w++){const x=i[w],M=i[w+1],T=k(h,x,v,n),F=k(h,M,v,n),y=k(h,(x+M)/2,v,n);for(let b=0;b<y.length;b++){a&&=T[b].length===d[b].length&&F[b].length===d[b].length;for(let D=0;D<y[b].length;D++){const P=T[b][D],N=F[b][D],W=y[b][D],U=Math.hypot((P.x+N.x)/2-W.x,(P.y+N.y)/2-W.y);U>r&&(r=U,u=`${h.text}, DRAW ${((x+M)/2).toFixed(2)}, weight ${v}, stroke ${b+1}, point ${D}`),x>=h.intervals[b].endDraw&&(c&&=P.x===N.x&&P.y===N.y)}const A=h.processed[b],L=h.intervals[b],H=(x-L.startDraw)/(L.endDraw-L.startDraw)*A.length;for(let D=0;D<A.points.length;D++)if(!(A.dot||H<1||A.points[D].distance>H-n.baseStrokeWidth*2))for(const P of[D,A.points.length*2+12-D]){const N=T[b][P],W=F[b][P];m&&=Math.hypot(N.x-W.x,N.y-W.y)<1e-8}}}}}return{checks:[{name:"Point counts and ordering remain compatible",passed:a,detail:"All contour counts across sampled DRAW × weight states"},{name:"DRAW 0 is fully collapsed at every tested weight",passed:l,detail:"All contours have one coordinate and zero area"},{name:"Future strokes remain fully collapsed",passed:o,detail:"Each stroke checked at its exact start boundary"},{name:"Completed strokes stay fixed",passed:c,detail:"Coordinates compared after each stroke finishes"},{name:"Completed ink within an active stroke stays fixed",passed:m,detail:"Both banks checked behind the moving-cap region, including intermediate weights"},{name:"Intermediate outline error ≤ 4 font units",passed:r<=4,detail:`${r.toFixed(2)} units maximum (1 px at 250 px/em); worst: ${u}`}],maxInterpolationError:r}}let E;const C=e=>{e.type==="result"?self.postMessage(e,{transfer:[e.result.ttf.buffer,e.result.woff2.buffer]}):self.postMessage(e)};self.onmessage=async e=>{const{id:n,project:t,drawSamples:s,refineCurves:a,engine:l,kind:o="animated"}=e.data,c=performance.now();try{const m=performance.now();if(!E){C({id:n,type:"progress",stage:"Loading local Python runtime (first build only)…"});const A=await(await import(new URL(J("compiler/pyodide.mjs"),self.location.origin).href)).loadPyodide({indexURL:new URL(J("compiler/"),self.location.origin).href});C({id:n,type:"progress",stage:"Loading FontTools and Brotli…"}),await A.loadPackage(["fonttools","brotli"]),await A.runPythonAsync(le),E=A}const r=performance.now()-m;C({id:n,type:"progress",stage:"Processing centrelines and checking compatible outlines…"});const u=performance.now(),f=I(t).map(y=>_e(Z(y,t))),p=f.map(y=>{if(o==="static")return[1e3];const b=ve([y],s);return a?Se([y],t.settings,b):b}),g=[...new Set(p.flat())].sort((y,b)=>y-b),h=o==="static"?{checks:[],maxInterpolationError:0}:Le(f,t.settings,g,p),i=y=>y.map(b=>[b.x,b.y]),d=[".notdef",...f.map(y=>y.glyphName)];if(new Set(d).size!==d.length)throw new Error("Duplicate glyph names");const v=We(t),_=o==="static"?0:f.reduce((y,b,A)=>y+(b.processed.length?p[A].length*3:0),0),w={glyphNames:d,advances:{".notdef":500,...Object.fromEntries(f.map(y=>[y.glyphName,y.advanceWidth]))},cmap:Object.fromEntries([...t.font.glyphs,...t.font.variants??[]].filter(y=>[...y.text].length===1).map(y=>[y.text.codePointAt(0),y.glyphName])),metrics:t.font.metrics,familyName:t.font.familyName,feature:v,engine:o==="static"?"static":l,defaultOutlines:Object.fromEntries(f.map(y=>[y.glyphName,k(y,1e3,400,t.settings).map(i)]))};let x=performance.now()-u;const M=E.globals.get("start_font"),T=E.globals.get("add_glyph"),F=E.globals.get("finish_font");try{const y=E.toPy(w);try{M(y)}finally{y.destroy()}for(const[N,W]of(o==="static"?[]:f).entries()){C({id:n,type:"progress",stage:`Encoding glyph ${N+1} of ${f.length} (${_} sampled states)…`});const U=performance.now(),Ie={name:W.glyphName,defaultContours:w.defaultOutlines[W.glyphName],masters:W.processed.length?p[N].flatMap(re=>[100,400,900].map(ie=>({draw:re,weight:ie,contours:k(W,re,ie,t.settings).map(i)}))):[]};x+=performance.now()-U;const ae=E.toPy(Ie);try{T(ae)}finally{ae.destroy()}}const b=performance.now(),A=(o==="static"?[1e3]:[0,137,517,663,918.4,1e3]).map(N=>({draw:N,weight:o==="static"?400:650,outlines:Object.fromEntries(f.map(W=>[W.glyphName,k(W,N,o==="static"?400:650,t.settings).map(i)]))}));x+=performance.now()-b,C({id:n,type:"progress",stage:"Compressing TTF and WOFF2, then checking the exported font…"});const L=E.toPy(A);try{F(L)}finally{L.destroy()}const H=new Uint8Array(E.FS.readFile("/tmp/handwriting.ttf")),D=new Uint8Array(E.FS.readFile("/tmp/handwriting.woff2")),P=JSON.parse(new TextDecoder().decode(E.FS.readFile("/tmp/handwriting-report.json")));C({id:n,type:"result",result:{kind:o,ttf:H,woff2:D,data:Re(t,f),sourceRevision:t.revision,diagnostics:{runtimeMs:r,geometryMs:x,assemblyMs:P.assemblyMs,totalMs:performance.now()-c,masters:_,drawLocations:g,checks:[...h.checks,...P.checks],maxInterpolationError:h.maxInterpolationError,stageMs:P.stageMs}}})}finally{M.destroy(),T.destroy(),F.destroy();for(const y of["/tmp/handwriting.ttf","/tmp/handwriting.woff2","/tmp/handwriting-report.json"])try{E.FS.unlink(y)}catch{}}}catch(m){C({id:n,type:"error",message:m instanceof Error?m.message:String(m)})}}})();
