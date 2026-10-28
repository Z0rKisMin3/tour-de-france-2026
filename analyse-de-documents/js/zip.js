/*
 * Lecteur ZIP minimal (pour .docx / .odt), sans dépendance.
 * Utilise DecompressionStream('deflate-raw') natif du navigateur.
 */
const Zip = (() => {
  const SIG_EOCD = 0x06054b50;
  const SIG_CENTRAL = 0x02014b50;
  const SIG_LOCAL = 0x04034b50;

  function listEntries(buf) {
    const dv = new DataView(buf);
    const min = Math.max(0, buf.byteLength - 65557);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= min; i--) {
      if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("Le fichier n'est pas une archive valide (ZIP introuvable).");

    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder('utf-8');
    const entries = new Map();
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== SIG_CENTRAL) throw new Error('Archive corrompue (répertoire central).');
      const method = dv.getUint16(p + 10, true);
      const compressedSize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const localOffset = dv.getUint32(p + 42, true);
      const name = dec.decode(new Uint8Array(buf, p + 46, nameLen));
      entries.set(name, { method, compressedSize, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('Ce navigateur ne sait pas décompresser les fichiers .docx/.odt. Utilisez une version récente de Chrome, Edge, Firefox ou Safari.');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function readFile(buf, entries, name) {
    const e = entries.get(name);
    if (!e) return null;
    const dv = new DataView(buf);
    const lo = e.localOffset;
    if (dv.getUint32(lo, true) !== SIG_LOCAL) throw new Error('Archive corrompue (en-tête local).');
    const nameLen = dv.getUint16(lo + 26, true);
    const extraLen = dv.getUint16(lo + 28, true);
    const data = new Uint8Array(buf, lo + 30 + nameLen + extraLen, e.compressedSize);
    if (e.method === 0) return data;
    if (e.method === 8) return inflateRaw(data);
    throw new Error('Méthode de compression non prise en charge (' + e.method + ').');
  }

  async function open(buf) {
    const entries = listEntries(buf);
    return {
      has: (name) => entries.has(name),
      names: () => [...entries.keys()],
      async text(name) {
        const bytes = await readFile(buf, entries, name);
        return bytes ? new TextDecoder('utf-8').decode(bytes) : null;
      },
    };
  }

  return { open };
})();
