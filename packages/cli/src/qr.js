// The grill link as a terminal QR: ECC level M, a quiet zone of 2 modules, Unicode half blocks
// (▀ ▄ █ and space), one text row per two module rows.
// mode "dark" paints the LIGHT modules (and the quiet zone) — for a dark terminal background.
// mode "light" paints the dark modules — for a light terminal background.
import qrcode from "qrcode-generator";

const QUIET = 2;
const GLYPHS = { "00": " ", "10": "▀", "01": "▄", "11": "█" }; // top bit, bottom bit

export function qrText(link, { mode = "dark" } = {}) {
  if (mode !== "dark" && mode !== "light") throw new Error('qr mode must be "dark" or "light"');
  const qr = qrcode(0, "M");
  qr.addData(String(link));
  qr.make();
  const n = qr.getModuleCount();
  const painted = (r, c) => {
    const dark = r >= 0 && r < n && c >= 0 && c < n ? qr.isDark(r, c) : false;
    return mode === "dark" ? !dark : dark;
  };
  const lines = [];
  for (let r = -QUIET; r < n + QUIET; r += 2) {
    let line = "";
    for (let c = -QUIET; c < n + QUIET; c++) {
      line += GLYPHS[(painted(r, c) ? "1" : "0") + (painted(r + 1, c) ? "1" : "0")];
    }
    lines.push(line);
  }
  return lines.join("\n");
}
