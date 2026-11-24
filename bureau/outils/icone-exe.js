// Met l'icône et le nom de La Maison Blanche dans le .exe (sans Windows ni wine)
const fs = require('fs'), path = require('path'), ResEdit = require('resedit');
module.exports = async function (ctx) {
  const exe = path.join(ctx.appOutDir, ctx.packager.appInfo.productFilename + '.exe');
  const pe = ResEdit.NtExecutable.from(fs.readFileSync(exe), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(pe);
  const ico = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.ico')));
  const ids = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const id = ids.length ? ids[0].id : 1, lang = ids.length ? ids[0].lang : 1033;
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, id, lang, ico.icons.map(i => i.data));
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
  if (vi) {
    const v = ctx.packager.appInfo.version.split('.').map(Number);
    vi.setFileVersion(v[0], v[1], v[2], 0); vi.setProductVersion(v[0], v[1], v[2], 0);
    vi.setStringValues({ lang: 1033, codepage: 1200 }, { FileDescription: 'Rapports La Maison Blanche', ProductName: 'Rapports La Maison Blanche', CompanyName: 'La Maison Blanche', OriginalFilename: 'Rapports La Maison Blanche.exe', LegalCopyright: 'La Maison Blanche' });
    vi.outputToResourceEntries(res.entries);
  }
  res.outputResource(pe);
  fs.writeFileSync(exe, Buffer.from(pe.generate()));
  console.log('  • icône et nom appliqués à', path.basename(exe));
};
