import { View, div } from 'gpui-kit';
import { appHome, checking, readTextFile, writeTextFile } from 'herdr';
export default class Probe extends View {
  init(_props, cx) {
    const home = appHome();
    if (!checking() || !home.startsWith('/tmp/reclaim-s6-')) throw new Error('Only isolated S6 check mode is allowed');
    this.status = 'pending';
    cx.spawn(async (cx) => {
      const file = `${home}/../outside.json`;
      try {
        await writeTextFile(file, 'first', null);
        let staleRejected = false;
        try { await writeTextFile(file, 'wrong', null); } catch { staleRejected = true; }
        if (!staleRejected) throw new Error('stale create was accepted');
        if (await readTextFile(file) !== 'first') throw new Error('stale CAS modified file');
        await writeTextFile(file, 'S6_EXTERNAL_CAS_OK', 'first');
        if (await readTextFile(file) !== 'S6_EXTERNAL_CAS_OK') throw new Error('roundtrip mismatch');
        this.status = 'S6_EXTERNAL_CAS_OK';
        console.log(this.status);
      } catch (error) {
        this.status = String(error);
        console.error(this.status);
      }
      cx.notify();
    });
  }
  render() { return div().child(this.status ?? 'pending'); }
}
