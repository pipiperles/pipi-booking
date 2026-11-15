/* PiPi 预约网站 · 共用：配置、座位布局、数据接口
   gasUrl = 「PiPi预约」Google 表格里 Apps Script 网页应用的网址（…/exec）。
   gasUrl 和 supabase 都留空 = 演示模式（数据只存在本机浏览器） */
window.PIPI = (function () {
  const CONFIG = {
    gasUrl: 'https://script.google.com/macros/s/AKfycbwxnPR1LAy40_WUZL7YsAVqzBc0jaJccSumND8BS-NqEWsoitp0PAgMZLOQSQpcO21BZg/exec',
    supabaseUrl: '',
    supabaseKey: '', // Supabase 的 anon public key（公开的，可以放网页里）
    open: 12 * 60, close: 20 * 60, step: 30, maxSeats: 8, daysAhead: 30,
    address: '24 rue Saint-Denis, 75001 Paris · Chongqing Noodles 二楼 / 1er étage',
  };

  /* 2026-11-15 小柱手绘图：两排 8 张桌 26 座。top = 上边一侧（a b），bottom = 下边（c d） */
  const TABLES = [['A1','A',2,2],['A2','A',2,2],['A3','A',2,2],['A4','A',1,1],
                  ['B1','B',1,1],['B2','B',2,2],['B3','B',2,2],['B4','B',1,1]]
    .map(([name,row,top,bottom]) => ({name,row,top,bottom}));
  const L = 'abcdefgh';
  const seatIds = t => Array.from({length:t.top+t.bottom}, (_,i) => t.name + L[i]);
  const ALL_SEATS = TABLES.flatMap(seatIds);

  const pad = n => String(n).padStart(2,'0');
  const ymd = d => d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
  const hm = m => pad(Math.floor(m/60))+':'+pad(m%60);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const overlap = (a,b) => a.start < b.end && b.start < a.end;

  const gas = !!CONFIG.gasUrl;
  const live = gas || !!(CONFIG.supabaseUrl && CONFIG.supabaseKey);
  let sb = null;
  const client = () => sb ??= window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey);

  /* ---- 演示模式 ---- */
  const DEMO_KEY = 'pipi-demo-bookings';
  let mem = null;
  function demo() {
    if (mem) return mem;
    try { const d = JSON.parse(localStorage.getItem(DEMO_KEY)); if (Array.isArray(d)) return mem = d; } catch (e) {}
    const t = new Date(); t.setDate(t.getDate()+1); const ds = ymd(t);
    return mem = [
      {id:'demo1',date:ds,start:14*60,end:17*60,seats:['A1a','A1b','A1c'],name:'示例 Lily',phone:'+33 6 00 00 00 01',wechat:'demo_lily',xhs:'',email:'',note:'演示数据',status:'confirmed',created:Date.now(),lang:'zh'},
      {id:'demo2',date:ds,start:13*60,end:20*60,seats:['B2a','B2b'],name:'示例 小王',phone:'+33 7 00 00 00 02',wechat:'',xhs:'小王爱拼豆',email:'',note:'',status:'confirmed',created:Date.now(),lang:'zh'}];
  }
  const dsave = () => { try { localStorage.setItem(DEMO_KEY, JSON.stringify(mem)); } catch (e) {} };
  const norm = x => ({id:x.id,date:x.date,start:x.start_min,end:x.end_min,seats:x.seats,name:x.name,phone:x.phone,
    wechat:x.wechat||'',xhs:x.xhs||'',email:x.email||'',note:x.note||'',plan:x.plan,status:x.status,created:Date.parse(x.created_at),lang:x.lang});

  const api = {
    live,
    /* 某天已被占的座位和时段（不含客人信息） */
    async busy(date) {
      if (!live) return demo().filter(b => b.date === date && b.status === 'confirmed').map(b => ({seats:b.seats,start:b.start,end:b.end}));
      if (gas) { const r = await fetch(CONFIG.gasUrl + '?action=busy&date=' + encodeURIComponent(date)); if (!r.ok) throw new Error('busy ' + r.status); return r.json(); }
      const {data, error} = await client().rpc('get_busy', {d: date});
      if (error) throw error;
      return data.map(x => ({seats:x.seats,start:x.start_min,end:x.end_min}));
    },
    /* 提交预约：成功 {ok:true}；座位被抢 {ok:false, conflict:[座位]} */
    async create(b) {
      if (!live) {
        const clash = demo().filter(x => x.date === b.date && x.status === 'confirmed' && overlap(x,b))
          .flatMap(x => x.seats).filter(s => b.seats.includes(s));
        if (clash.length) return {ok:false, conflict:[...new Set(clash)]};
        mem.push({...b, id:'d'+Date.now(), status:'confirmed', created:Date.now()}); dsave();
        return {ok:true};
      }
      if (gas) {  // 后台自己分座；text/plain 避免跨域预检
        const r = await fetch(CONFIG.gasUrl, {method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'}, body: JSON.stringify(b)});
        const j = await r.json();
        if (j.ok) return {ok:true, seats:j.seats};
        if (j.error === 'FULL') return {ok:false, conflict:[]};
        throw new Error(j.error + (j.detail ? ': ' + j.detail : ''));
      }
      const {error} = await client().rpc('create_booking', {p_date:b.date,p_start:b.start,p_end:b.end,p_seats:b.seats,
        p_plan:b.plan,p_name:b.name,p_phone:b.phone,p_wechat:b.wechat,p_xhs:b.xhs,p_email:b.email,p_note:b.note,p_lang:b.lang});
      if (error) {
        if (/SEAT_TAKEN/.test(error.message)) return {ok:false, conflict:String(error.details||'').split(',').filter(Boolean)};
        throw error;
      }
      return {ok:true};
    },
    /* ---- 管理页 ---- */
    async session() { if (!live) return {demo:true}; return (await client().auth.getSession()).data.session; },
    async login(email, password) { const {error} = await client().auth.signInWithPassword({email,password}); if (error) throw error; },
    async logout() { if (live) await client().auth.signOut(); },
    async list(date) {
      if (!live) return demo().filter(b => b.date === date).sort((a,b) => a.start-b.start);
      const {data, error} = await client().from('bookings').select('*').eq('date', date).order('start_min');
      if (error) throw error;
      return data.map(norm);
    },
    async setStatus(id, status) {
      if (!live) { demo().find(x => x.id === id).status = status; dsave(); return; }
      const {error} = await client().from('bookings').update({status}).eq('id', id);
      if (error) throw error;
    },
  };

  return {CONFIG, TABLES, L, seatIds, ALL_SEATS, pad, ymd, hm, esc, overlap, api};
})();
