/** Getter fixture: no DB open, filesystem mutation or model. */
import {it,expect,vi} from 'vitest';
import {MakerMemoryStore} from './store.js';
it('attests SQLite main database path instead of guessing from the configured directory',()=>{
 const pragma=vi.fn(()=>[{name:'main',file:'/fixture-other-owner/fts.db'},{name:'temp',file:''}]);const scopeCheck=vi.fn();
 const store=new MakerMemoryStore({storageDir:'/fixture-owner/bots/bot/memories',absWorkdir:'bot:bot',db:{pragma}as any,logger:{}as any,scopeCheck});
 const identity=store.getStorageIdentity();expect(pragma).toHaveBeenCalledWith('database_list');expect(scopeCheck).toHaveBeenCalledOnce();
 expect(identity).toEqual({scopeKey:'bot:bot',storageDir:'/fixture-owner/bots/bot/memories',databasePath:'/fixture-other-owner/fts.db'});expect(Object.isFrozen(identity)).toBe(true);
});
