// TV ao Vivo: categorias + grade de canais; ao assistir, vídeo grande + lista lateral.
import { h, ico, img, windowed, matcher, debounce, fmtClock, toast } from '../core/util.js';
import { isPhone, catSelect } from '../core/catselect.js';
import { starIcon } from '../core/icons.js';
import {
  C, S, visibleCats, visibleItems, favItems, recentItems, clearRecents, catItems, adultLocked, isAdultItem, isFav, toggleFav, addRecent,
  fetchEpg, epgFor, nowNext, epgState, setSetting,
} from '../core/store.js';
import { Player } from '../player/player.js';
import { TV, focusEl } from '../tv/tv.js';

const SPECIAL = { all: 'Todos os canais', fav: 'Favoritos', recent: 'Recentes' };

function catTitle(cat) {
  return SPECIAL[cat] || C().live.catName.get(cat) || 'Canais';
}

function itemsFor(cat) {
  if (cat === 'fav') return favItems('live');
  if (cat === 'recent') return recentItems('live');
  if (cat === 'all') return visibleItems('live');
  return catItems('live', cat);
}

function defaultCat() {
  if (favItems('live').length) return 'fav';
  return 'all';
}

export function liveView(params, ctx) {
  let cat = params.get('cat') || defaultCat();
  let query = '';
  let player = null;
  let playingId = null;
  let list = [];
  let inc = null;
  let sideInc = null;
  const cards = new Map(); // id -> [elements de "agora"]
  let epgTimer = null;
  let epgRetry = null;

  const root = h('div.live');
  const catFilter = h('input', { placeholder: 'Filtrar categorias' });
  const catList = h('div.cat-list');
  // celular: seletor nativo de categoria e, ao lado, o Guia (a barra de baixo não tem o Guia)
  const phoneBar = isPhone() ? h('div.cat-bar', catSelect(catList), h('a.btn.guide-link', { href: '#/guide', title: 'Guia de programação' }, ico('guide'), 'Guia')) : null;
  const cats = h('div.cats' + (phoneBar ? '.has-select' : ''), phoneBar, h('label.filter', ico('search'), catFilter), catList);
  const channels = h('div.channels');
  root.append(cats, channels);

  catFilter.addEventListener('input', debounce(renderCats, 120));

  // ---------- categorias ----------
  function renderCats() {
    const m = matcher(catFilter.value);
    catList.replaceChildren();
    const btn = (id, name, n, icn) =>
      h('button.cat-item' + (id === cat ? '.on' : ''), { onclick: () => ctx.navigate(`#/live?cat=${encodeURIComponent(id)}`) },
        icn ? ico(icn) : null, h('span.name', name), n != null ? h('span.n', n) : null);
    if (!catFilter.value) {
      catList.append(
        btn('all', 'Todos os canais', visibleItems('live').length, 'tv'),
        btn('fav', 'Favoritos', favItems('live').length, 'star'),
        btn('recent', 'Recentes', recentItems('live').length, 'history'),
        h('div.cat-sep'),
      );
    }
    for (const c of visibleCats('live')) if (m(c.name)) catList.append(btn(c.id, c.name, c.count));
  }

  // ---------- cartões de canal ----------
  function nowLine(ch) {
    const { now } = nowNext(epgFor(ch.id));
    if (!now) return { text: '', pct: null };
    const pct = Math.max(0, Math.min(100, ((Date.now() - now[0]) / (now[1] - now[0])) * 100));
    return { text: `${fmtClock(now[0])}  ${now[2]}`, pct };
  }

  function paintNow(ch) {
    const els = cards.get(ch.id);
    if (!els) return;
    const { text, pct } = nowLine(ch);
    const st = epgState().status;
    const pending = !text && (st === 'unknown' || st === 'loading');
    for (const el of els) {
      el.now.textContent = text;
      el.now.classList.toggle('sk-now', pending);
      el.bar.classList.toggle('hidden', pct == null);
      if (pct != null) el.bar.firstChild.style.width = pct + '%';
    }
  }

  function channelCard(ch, compact) {
    const now = h('div.now');
    const bar = h('div.bar.hidden', h('i'));
    const star = h('button.icon-btn', {
      title: 'Favorito',
      html: starIcon(isFav('live', ch.id)),
      onclick: (e) => {
        e.stopPropagation();
        const on = toggleFav('live', ch.id);
        for (const s of document.querySelectorAll(`[data-fav="${CSS.escape(ch.id)}"]`)) s.innerHTML = starIcon(on);
        if (!compact) renderCats();
      },
    });
    star.dataset.fav = ch.id;
    const card = h('div.ch-card' + (ch.id === playingId ? '.playing' : ''), { onclick: () => play(ch.id), title: ch.name },
      img(ch.logo, ch.name), h('div.info', h('div.name', ch.name), now, bar), star);
    card.dataset.id = ch.id;
    // cartões que saíram da tela não precisam mais receber a guia
    cards.set(ch.id, (cards.get(ch.id) || []).filter((c) => c.now.isConnected));
    cards.get(ch.id).push({ now, bar });
    paintNow(ch);
    return card;
  }

  async function loadEpgFor(chs) {
    const st = await fetchEpg(chs);
    for (const ch of chs) paintNow(ch);
    if (player && playingId) paintWatchEpg();
    if (st.status === 'loading' && !epgRetry) {
      epgRetry = setTimeout(async () => {
        epgRetry = null;
        const rendered = list.slice(0, inc ? inc.rendered() : 0);
        await loadEpgFor(rendered.filter((c) => !epgFor(c.id)).length ? rendered : []);
      }, 15000);
    }
  }

  function filtered() {
    let arr = itemsFor(cat);
    if (query) {
      const m = matcher(query);
      arr = arr.filter((c) => m(c.name));
    }
    if (S.settings.liveSort === 'az') arr = [...arr].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { numeric: true }));
    return arr;
  }

  // ---------- modo grade ----------
  function renderGrid() {
    root.classList.remove('watching');
    destroyPlayer();
    cards.clear();
    inc && inc.destroy();
    list = filtered();
    const localFilter = h('input', { placeholder: 'Filtrar nesta categoria', value: query });
    localFilter.addEventListener('input', debounce(() => {
      query = localFilter.value;
      fillGrid();
    }, 150));
    const sortChip = h('button.chip' + (S.settings.liveSort === 'az' ? '.on' : ''), {
      onclick: () => {
        setSetting('liveSort', S.settings.liveSort === 'az' ? 'orig' : 'az');
        sortChip.classList.toggle('on', S.settings.liveSort === 'az');
        fillGrid();
      },
    }, ico('sort'), 'A–Z');
    const count = h('span.count');
    const grid = h('div.ch-grid');
    const scroll = h('div.ch-scroll', grid);
    channels.replaceChildren(
      h('div.ch-head', h('h2', catTitle(cat)), count,
        cat === 'recent' && list.length ? h('button.link-btn', {
          title: 'Apagar o histórico de canais assistidos',
          onclick: () => {
            const undo = clearRecents('live');
            renderGrid();
            renderCats();
            toast('Recentes limpos', 'info', 6000, { label: 'Desfazer', fn: () => { undo(); renderGrid(); renderCats(); } });
          },
        }, 'Limpar') : null,
        h('div.grow'), h('label.filter', { style: { width: '260px' } }, ico('search'), localFilter), sortChip),
      scroll,
    );

    function fillGrid() {
      inc && inc.destroy();
      cards.clear();
      grid.replaceChildren();
      list = filtered();
      count.textContent = `${list.length.toLocaleString('pt-BR')} canais`;
      if (!list.length) {
        grid.append(h('div.empty', { style: { gridColumn: '1/-1' } },
          cat === 'fav' ? 'Nenhum favorito ainda. Clique na ★ de um canal para adicionar.' : cat === 'recent' ? 'Nenhum canal assistido ainda.' : 'Nenhum canal encontrado.'));
        return;
      }
      // na TV, só o que cabe na tela e um pouco mais: montar 90 canais (logo e guia) de uma vez derrubava o FPS na troca de tela
      inc = windowed(grid, list, (ch) => channelCard(ch, false), { root: scroll, batch: TV.on ? 30 : 90, onBatch: loadEpgFor });
    }
    fillGrid();
    ctx.setTitle('TV ao Vivo');
    if (TV.on && lastPlayed) {
      // voltando do canal: foco no cartão dele
      const idx = list.findIndex((c) => c.id === lastPlayed);
      if (idx >= 0 && inc) inc.ensure(idx + 1);
      setTimeout(() => focusEl(grid.querySelector(`[data-id="${CSS.escape(lastPlayed)}"]`), { center: true }), 40);
    }
  }

  // ---------- modo assistindo ----------
  let watchEls = null;

  function renderWatch() {
    root.classList.add('watching');
    root.classList.toggle('tvfull', TV.on);
    cards.clear();
    inc && inc.destroy();
    const title = h('div.title');
    const star = h('button.icon-btn', { title: 'Favorito' });
    const box = h('div.player-box');
    const nowCard = h('div.epg-card');
    const nextCard = h('div.epg-card');
    const watch = h('div.watch',
      h('div.watch-top',
        h('button.btn.small.ghost', { onclick: () => ctx.navigate(`#/live?cat=${encodeURIComponent(cat)}`) }, ico('back'), 'Canais'),
        title, star),
      box,
      h('div.epg-now', nowCard, nextCard),
      TV.on ? h('div.hint', '▲▼ trocar canal  ·  ◀ lista de canais  ·  OK controles  ·  ▶ informações') : null);

    const sel = h('select.input');
    const addOpt = (id, name) => sel.append(h('option', { value: id, selected: id === cat }, name));
    addOpt('all', 'Todos os canais');
    addOpt('fav', 'Favoritos');
    addOpt('recent', 'Recentes');
    for (const c of visibleCats('live')) addOpt(c.id, `${c.name} (${c.count})`);
    sel.addEventListener('change', () => {
      cat = sel.value;
      query = '';
      sideFilter.value = '';
      fillSide();
      history.replaceState(null, '', `#/live?cat=${encodeURIComponent(cat)}&ch=${encodeURIComponent(playingId)}`);
    });
    const sideFilter = h('input', { placeholder: 'Filtrar canais' });
    sideFilter.addEventListener('input', debounce(() => { query = sideFilter.value; fillSide(); }, 150));
    const sideScroll = h('div.side-scroll');
    const side = h('div.side-list', h('div.head', sel, h('label.filter', ico('search'), sideFilter)), sideScroll);

    channels.replaceChildren(watch);
    root.querySelector('.side-list')?.remove();
    root.append(side);

    player = new Player(box, { live: true, onCancel: () => ctx.navigate(`#/live?cat=${encodeURIComponent(cat)}`) });
    watchEls = { title, star, nowCard, nextCard, sideScroll };

    function fillSide() {
      sideInc && sideInc.destroy();
      cards.clear();
      sideScroll.replaceChildren();
      list = filtered();
      if (!list.length) sideScroll.append(h('div.empty', 'Nada aqui.'));
      sideInc = windowed(sideScroll, list, (ch) => channelCard(ch, true), { root: sideScroll, batch: TV.on ? 30 : 80, onBatch: loadEpgFor });
      scrollToPlaying();
    }
    watchEls.fillSide = fillSide;
    fillSide();
    ctx.setTitle('TV ao Vivo');
  }

  // center: ao abrir o canal ou a gaveta, centraliza o que está tocando. Ao trocar de canal, a lista
  // fica onde está e só rola o mínimo se o canal estiver fora da área visível (zapping com ↑/↓ na TV).
  // Rola só a lista: scrollIntoView também moveria a página.
  function scrollToPlaying(center = true) {
    if (!watchEls) return;
    const idx = list.findIndex((c) => c.id === playingId);
    if (idx < 0) return;
    // só o próprio canal: pedir os de baixo fazia a lista pular ao clicar perto do fim do trecho carregado
    sideInc && sideInc.ensure(idx + 1);
    // espera o próximo quadro: na primeira renderização a view ainda não está no documento.
    setTimeout(() => {
      const box = watchEls && watchEls.sideScroll;
      const el = box && box.querySelector(`[data-id="${CSS.escape(playingId)}"]`);
      if (!el) return;
      const b = box.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const top = r.top - b.top + box.scrollTop;
      if (center) box.scrollTop = top - (box.clientHeight - r.height) / 2;
      else if (r.top < b.top) box.scrollTop = top;
      else if (r.bottom > b.bottom) box.scrollTop = top - box.clientHeight + r.height;
    }, 20);
  }

  function paintWatchEpg() {
    if (!watchEls) return;
    const ch = C().live.byId.get(playingId);
    if (!ch) return;
    const progs = epgFor(ch.id);
    const { now, next } = nowNext(progs);
    const st = epgState().status;
    const card = (el, label, p, live) => {
      el.replaceChildren(h('div.lbl',
        live && p ? h('span.badge.onair', { style: { flex: 'none' } }, 'AGORA') : h('span', label),
        p ? h('span', { style: { whiteSpace: 'nowrap' } }, `${fmtClock(p[0])} – ${fmtClock(p[1])}`) : null));
      if (p) {
        el.append(h('div.t', p[2]));
        if (live) {
          const pct = ((Date.now() - p[0]) / (p[1] - p[0])) * 100;
          el.append(h('div.bar', { style: { margin: '6px 0 8px' } }, h('i', { style: { width: pct + '%' } })));
        }
        if (p[3]) el.append(h('div.d', p[3]));
      } else {
        el.append(h('div.d', st === 'loading' ? 'Carregando guia...' : st === 'none' ? 'Esta lista não tem guia de programação.' : 'Sem informação de programação.'));
      }
    };
    card(watchEls.nowCard, 'Agora', now, true);
    card(watchEls.nextCard, 'A seguir', next, false);
  }

  function play(id) {
    const ch = C().live.byId.get(id);
    if (!ch || (adultLocked() && isAdultItem('live', id))) return;
    if (!root.classList.contains('watching')) {
      ctx.navigate(`#/live?cat=${encodeURIComponent(cat)}&ch=${encodeURIComponent(id)}`);
      return;
    }
    playingId = id;
    addRecent('live', id);
    watchEls.title.textContent = ch.name;
    watchEls.star.innerHTML = starIcon(isFav('live', id));
    watchEls.star.dataset.fav = id;
    watchEls.star.onclick = () => {
      const on = toggleFav('live', id);
      for (const s of document.querySelectorAll(`[data-fav="${CSS.escape(id)}"]`)) s.innerHTML = starIcon(on);
    };
    for (const el of root.querySelectorAll('.ch-card.playing')) el.classList.remove('playing');
    for (const el of root.querySelectorAll(`.ch-card[data-id="${CSS.escape(id)}"]`)) el.classList.add('playing');
    player.load({ url: ch.url, alt: ch.alt, title: ch.name });
    if (TV.on) {
      closeDrawer();
      showInfo();
    }
    history.replaceState(null, '', `#/live?cat=${encodeURIComponent(cat)}&ch=${encodeURIComponent(id)}`);
    scrollToPlaying(false);
    fetchEpg([ch]).then(paintWatchEpg);
    paintWatchEpg();
  }

  // ---------- TV: banner de informações e gaveta de canais ----------
  let infoT = null;
  function showInfo() {
    root.classList.add('info');
    clearTimeout(infoT);
    infoT = setTimeout(() => root.classList.remove('info'), 5000);
  }

  function openDrawer() {
    root.classList.add('drawer');
    root.classList.remove('info');
    scrollToPlaying();
    setTimeout(() => {
      const el = watchEls && (watchEls.sideScroll.querySelector('.ch-card.playing') || watchEls.sideScroll.querySelector('.ch-card'));
      focusEl(el, { center: true });
    }, 40);
  }

  function closeDrawer() {
    if (!root.classList.contains('drawer')) return;
    root.classList.remove('drawer');
    if (document.activeElement && root.contains(document.activeElement)) document.activeElement.blur();
  }

  function step(d) {
    if (!list.length) return;
    const i = list.findIndex((c) => c.id === playingId);
    const next = list[(i + d + list.length) % list.length];
    if (next) play(next.id);
  }

  let lastPlayed = null;
  function destroyPlayer() {
    if (playingId) lastPlayed = playingId;
    if (player) player.destroy();
    player = null;
    playingId = null;
    watchEls = null;
    root.classList.remove('tvfull', 'drawer', 'info');
    clearTimeout(infoT);
    sideInc && sideInc.destroy();
    root.querySelector('.side-list')?.remove();
  }

  function apply(p) {
    const newCat = p.get('cat') || cat;
    let ch = p.get('ch');
    if (ch && adultLocked() && isAdultItem('live', ch)) ch = null; // controle dos pais
    const fromPlayer = !ch && root.classList.contains('watching');
    const catChanged = newCat !== cat;
    cat = newCat;
    if (catChanged) query = '';
    if (ch) {
      if (!root.classList.contains('watching')) renderWatch();
      else if (catChanged) watchEls.fillSide();
      if (ch !== playingId) play(ch);
    } else {
      renderGrid();
    }
    renderCats();
    // saindo do player, o foco volta para o canal que estava tocando
    if (TV.on && fromPlayer && lastPlayed) {
      inc && inc.ensure(list.findIndex((c) => c.id === lastPlayed) + 1);
      const card = channels.querySelector(`.ch-card[data-id="${CSS.escape(lastPlayed)}"]`);
      if (card) return focusEl(card, { center: true });
    }
    // renderCats recria a lista: na TV o foco volta para a categoria escolhida
    if (TV.on && !ch && (!document.activeElement || document.activeElement === document.body)) {
      focusEl(catList.querySelector('.cat-item.on'));
    }
  }

  apply(params);
  epgTimer = setInterval(() => {
    for (const ch of list.slice(0, 400)) paintNow(ch);
    paintWatchEpg();
  }, 60000);

  return {
    el: root,
    noScroll: true,
    update(p) {
      apply(p);
      return true;
    },
    key(e) {
      if (!player) return false;
      const k = e.key;
      const back = e.type === 'back';
      // com a tela de erro aberta, Voltar sai do canal (antes, na TV, só soltava o foco do "Tentar de novo",
      // que voltava para ele: a pessoa ficava presa)
      if (back && player.hasError()) {
        ctx.navigate(`#/live?cat=${encodeURIComponent(cat)}`);
        return true;
      }
      if (TV.on) {
        if (root.classList.contains('drawer')) {
          if (back) { closeDrawer(); return true; }
          return false; // setas/OK navegam na gaveta
        }
        if (back) {
          if (player._ctrlFocused()) { player.leaveControls(); root.classList.remove('info'); return true; }
          if (root.classList.contains('info')) { root.classList.remove('info'); return true; }
          ctx.navigate(`#/live?cat=${encodeURIComponent(cat)}`);
          return true;
        }
        // nos botões: ←/→ andam entre eles e ↑/↓ voltam a trocar de canal
        if (player._ctrlFocused() && (k === 'ArrowUp' || k === 'ArrowDown')) { player.leaveControls(); return true; }
        if (player._ctrlFocused() || !player.menu.classList.contains('hidden')) return player.handleKey(e);
        if (k === 'ArrowUp' || k === 'PageUp' || e.keyCode === 33) { step(-1); return true; }
        if (k === 'ArrowDown' || k === 'PageDown' || e.keyCode === 34) { step(1); return true; }
        if (k === 'ArrowLeft') { openDrawer(); return true; }
        if (k === 'Enter') { showInfo(); player.focusControls(); return true; }
        if (k === 'ArrowRight') { showInfo(); return true; }
        return player.handleKey(e);
      }
      if (k === 'ArrowUp' || k === 'PageUp') { step(-1); return true; }
      if (k === 'ArrowDown' || k === 'PageDown') { step(1); return true; }
      if (back && !document.fullscreenElement) {
        ctx.navigate(`#/live?cat=${encodeURIComponent(cat)}`);
        return true;
      }
      return player.handleKey(e);
    },
    destroy() {
      destroyPlayer();
      inc && inc.destroy();
      clearInterval(epgTimer);
      clearTimeout(epgRetry);
    },
  };
}
