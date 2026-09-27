// Backtick spans in backend prose (diagnostics details, empty-state copy)
// as data, so views can render them as `<code>` elements built from text
// nodes — never innerHTML (docs/design/VISUAL_SPEC.md §4.15).

/** 'run `lsof` now' → [{code:false,text:'run '},{code:true,text:'lsof'},{code:false,text:' now'}]. */
export function codeSpans(text) {
  const s = String(text ?? '');
  const out = [];
  const re = /`([^`]+)`/g;
  let last = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > last) out.push({ code: false, text: s.slice(last, m.index) });
    out.push({ code: true, text: m[1] });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ code: false, text: s.slice(last) });
  return out;
}
