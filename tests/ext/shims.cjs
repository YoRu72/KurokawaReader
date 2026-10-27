// The sandbox's shims against what the plugins expect of cheerio, htmlparser2 and dayjs: built from their
// sources into one script, run in a browser page, checked on a sample document.
// node tests/ext/shims.cjs
const path = require('path'); const fs = require('fs'); const os = require('os');
const esbuild = require(path.join(__dirname, '../../node_modules/esbuild'));
const { chromium } = require('playwright');
(async () => {
  const root = path.join(__dirname, '../..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-shims-'));
  const entry = path.join(tmp, 'entry.ts');
  fs.writeFileSync(entry, `
    import { load } from '${path.join(root, 'src/sources/ext/rt/cheerio.ts').replace(/\\\\/g, '/')}';
    import { Parser } from '${path.join(root, 'src/sources/ext/rt/htmlparser.ts').replace(/\\\\/g, '/')}';
    import { dayjs } from '${path.join(root, 'src/sources/ext/rt/dayjs.ts').replace(/\\\\/g, '/')}';
    import { select, matches } from '${path.join(root, 'src/sources/ext/rt/select.ts').replace(/\\\\/g, '/')}';
    import { MDocument, parseDates, unpackJs } from '${path.join(root, 'src/sources/ext/rt/mangayomi.ts').replace(/\\\\/g, '/')}';
    (window as any).RT = { load, Parser, dayjs, select, matches, MDocument, parseDates, unpackJs };
  `);
  await esbuild.build({ entryPoints: [entry], bundle: true, format: 'iife', outfile: path.join(tmp, 'rt.js'), platform: 'browser', target: 'es2020', logLevel: 'error' });
  const browser = await chromium.launch(); const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ path: path.join(tmp, 'rt.js') });
  const results = await page.evaluate(() => {
    const RT = window.RT; const out = [];
    const ok = (name, cond, note) => out.push([name, !!cond, note]);
    const html = `<!doctype html><html><head><title>Novel - Site</title></head><body>
      <div id="list" class="novels">
        <div class="novel-item" data-id="1"><a href="/novel/a" title="Alpha Novel"><img data-src="/c/a.jpg" src="placeholder.gif"></a><span class="title">Alpha Novel</span><p>Status: Ongoing</p></div>
        <div class="novel-item" data-id="2"><a href="/novel/b" title="Beta Tale"><img data-src="/c/b.jpg"></a><span class="title">Beta Tale</span><p>Status: Completed</p></div>
        <div class="novel-item" data-id="3"><a href="/novel/c" title="Gamma"><img src="/c/c.jpg"></a><span class="title">Gamma</span><p>Status: Ongoing</p></div>
      </div>
      <ul class="chapters"><li><a href="/ch/1">Chapter 1</a><time>2024-01-05</time></li><li><a href="/ch/2">Chapter 2</a></li><li class="locked"><a href="/ch/3">Chapter 3</a></li></ul>
      <div class="content"><p>First <b>para</b>.</p><script>var x = 1;</script><p class="ads">AD</p><p>Second para.</p><br><p></p></div>
      <table><tr><td>Author</td><td>Someone</td></tr><tr><td>Genre</td><td>Fantasy</td></tr></table>
      <select id="s"><option value="1">one</option><option value="2" selected>two</option></select>
    </body></html>`;
    // ---- cheerio
    const $ = RT.load(html);
    ok('load+find+text', $('.novel-item .title').first().text() === 'Alpha Novel');
    ok('length', $('.novel-item').length === 3);
    ok('attr', $('.novel-item a').attr('href') === '/novel/a' && $('.novel-item a').attr('nope') === undefined);
    ok('attr data-src vs src', $('.novel-item img').first().attr('data-src') === '/c/a.jpg');
    ok('each + $(el)', (() => { const names = []; $('.novel-item').each((i, el) => { names.push($(el).find('.title').text()); }); return names.join('|') === 'Alpha Novel|Beta Tale|Gamma'; })());
    ok('map().get()', $('.chapters li a').map((i, el) => $(el).attr('href')).get().join(',') === '/ch/1,/ch/2,/ch/3');
    ok('map().toArray()', $('.chapters li a').map((i, el) => $(el).text()).toArray().length === 3);
    ok('raw el.attribs', $('.novel-item a')[0].attribs.title === 'Alpha Novel' && $('.novel-item a').get(1).attribs.href === '/novel/b');
    ok('raw el.name/type/children', $('.novel-item')[0].name === 'div' && $('.novel-item')[0].type === 'tag' && $('.content').contents().get(0).type === 'tag' && $('.content').contents().get(1).type === 'script');
    ok('text node data', $('.content p').first().contents().get(0).type === 'text' && $('.content p').first().contents().get(0).data === 'First ');
    ok(':contains', $('p:contains("Status: Ongoing")').length === 2 && $("td:contains('Author') + td").text() === 'Someone');
    ok(':contains case-sensitive (cheerio)', $('p:contains("status")').length === 0);
    ok(':first/:last/:eq', $('.novel-item:first .title').text() === 'Alpha Novel' && $('.novel-item:last .title').text() === 'Gamma' && $('.chapters li:eq(1) a').text() === 'Chapter 2');
    ok(':not(:contains)', $('.chapters li:not(.locked)').length === 2 && $('p:not(:contains("Status"))').length >= 2);
    ok(':has', $('li:has(time)').length === 1);
    ok('nth-child', $('.chapters li:nth-child(2) a').attr('href') === '/ch/2');
    ok('html()', $('.content p').first().html() === 'First <b>para</b>.');
    ok('$.html(el)', $.html($('.content p').first()) === '<p>First <b>para</b>.</p>');
    ok('toString', $('.content p').first().toString() === '<p>First <b>para</b>.</p>');
    ok('remove + find', (() => { const c = $('.content').clone(); c.find('script, .ads').remove(); return !c.html().includes('script') && !c.html().includes('AD'); })());
    ok('remove mutates', (() => { const $2 = RT.load(html); $2('.content script, .content .ads').remove(); return !$2('.content').html().includes('<script'); })());
    ok('next/prev/parent/children/closest/siblings', $('.chapters li a').first().next().text() === '2024-01-05' && $('.chapters time').parent().is('li') && $('.content').children('p').length === 4 && $('.chapters time').closest('ul').hasClass('chapters') && $('.chapters li').first().siblings().length === 2);
    ok('nextAll/nextUntil', $('.content p').first().nextAll('p').length === 3 && $('.content p').first().nextUntil('.ads').length === 1);
    ok('filter fn/sel/not', $('.novel-item').filter((i, el) => $(el).find('p').text().includes('Completed')).length === 1 && $('.chapters li').filter('.locked').length === 1 && $('.chapters li').not('.locked').length === 2);
    ok('eq negative/get negative/slice', $('.chapters li').eq(-1).hasClass('locked') && $('.chapters li').get(-1).attribs.class === 'locked' && $('.chapters li').slice(1).length === 2);
    ok('data()', $('.novel-item').first().data('id') === 1 && $('.novel-item').first().data().id === 1);
    ok('val()', $('#s').val() === '2');
    ok('append/replaceWith/after/before', (() => { const $3 = RT.load('<div><p>a</p></div>', null, false); $3('div').append('<i>x</i>'); $3('p').after('<hr>'); $3('p').before('<b>y</b>'); $3('i').replaceWith('<u>z</u>'); return $3.html() === '<div><b>y</b><p>a</p><hr><u>z</u></div>'; })());
    ok('fragment load html()', RT.load('<p>a</p><p>b</p>', null, false).html() === '<p>a</p><p>b</p>');
    ok('document load html() wraps', RT.load('<p>a</p>').html().startsWith('<html>'));
    ok('$(html string)', $('<div class="k">x</div>').hasClass('k') && $('<p>1</p><p>2</p>').length === 2);
    ok('text setter/attr setter/removeAttr/addClass', (() => { const $4 = RT.load('<p id="p" class="a">x</p>'); $4('#p').text('y').attr('data-k', 'v').addClass('b c').removeAttr('id'); return $4('p').text() === 'y' && $4('p').attr('data-k') === 'v' && $4('p').hasClass('c') && $4('p').attr('id') === undefined; })());
    ok('prop tagName', $('.content').prop('tagName') === 'DIV');
    ok('context select', $('.title', $('.novel-item').last()).text() === 'Gamma' && $('.title', '.novel-item').length === 3);
    ok('xmlMode', RT.load('<rss><channel><item><title>T</title></item></channel></rss>', { xmlMode: true })('item title').text() === 'T');
    ok('end()', $('.novels').find('.title').end().hasClass('novels'));
    ok('index/add/is', $('.chapters li.locked').index() === 2 && $('.chapters li').first().add('.chapters li.locked').length === 2 && $('.chapters li').is('.locked'));
    ok('$.text root', $.text().includes('Alpha Novel'));
    ok('script contents in text', $('script').text() === 'var x = 1;');
    ok('empty set attr/text', $('.nothing').attr('x') === undefined && $('.nothing').text() === '' && $('.nothing').html() === null);
    ok('wrap/unwrap', (() => { const $5 = RT.load('<p>a</p>', null, false); $5('p').wrap('<div class="w"></div>'); const ok1 = $5.html() === '<div class="w"><p>a</p></div>'; $5('p').unwrap(); return ok1 && $5.html() === '<p>a</p>'; })());
    // ---- select engine edge cases
    const doc = new DOMParser().parseFromString(html, 'text/html');
    ok('select plain', RT.select([doc], '.novel-item').length === 3);
    ok('select nested custom', RT.select([doc], '.novel-item:contains("Beta") a').length === 1);
    ok('select :icontains', RT.select([doc], 'p:icontains("status: completed")').length === 1);
    ok('select :matches', RT.select([doc], 'span:matches(^Alpha)').length === 1);
    ok('select group with custom', RT.select([doc], 'time, li:contains("Chapter 3")').length === 2);
    ok('matches custom', RT.matches(doc.querySelector('.locked'), 'li:contains("Chapter 3")') && !RT.matches(doc.querySelector('.locked'), 'li:contains("Chapter 1")'));
    ok('select :gt/:lt', RT.select([doc], '.chapters li:gt(0)').length === 2 && RT.select([doc], '.chapters li:lt(1)').length === 1);
    ok('select comma inside quotes', RT.select([doc], 'p:contains("Status: Ongoing, x"), span.title').length === 3);
    ok('select unquoted contains (mangayomi)', RT.select([doc], 'p:contains(Status: Completed)', { icontains: true }).length === 1);
    // ---- Mangayomi Document
    const md = new RT.MDocument(html);
    ok('MDocument select/text/getHref', md.select('.novel-item a').length === 3 && md.selectFirst('.novel-item .title').text === 'Alpha Novel' && md.selectFirst('.novel-item a').getHref === '/novel/a');
    ok('MDocument getSrc first src= in outer', md.selectFirst('.novel-item img').getSrc === '/c/a.jpg');
    ok('MDocument missing element empty', md.selectFirst('.nope').text === '' && md.selectFirst('.nope').attr('x') === '' && md.selectFirst('.nope').select('a').length === 0);
    ok('MDocument :contains insensitive', md.select("p:contains('status: ongoing')").length === 2);
    ok('MDocument innerHtml/outerHtml', md.selectFirst('.content p').innerHtml === 'First <b>para</b>.' && md.selectFirst('.content p').outerHtml.startsWith('<p>'));
    ok('parseDates', Math.abs(Number(RT.parseDates('March 5, 2024', 'MMMM dd, yyyy')) - new Date(2024, 2, 5).getTime()) < 1000 && Number(RT.parseDates('05/03/2024', 'dd/MM/yyyy')) === new Date(2024, 2, 5).getTime());
    ok('unpackJs', RT.unpackJs("eval(function(p,a,c,k,e,d){e=function(c){return c.toString(36)};if(!''.replace(/^/,String)){while(c--){d[c.toString(a)]=k[c]||c.toString(a)}k=[function(e){return d[e]}];e=function(){return'\\\\w+'};c=1};while(c--){if(k[c]){p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c])}}return p}('0 1=\"2\";',3,3,'var|x|hello'.split('|'),0,{}))").includes('var x="hello"'));
    // ---- htmlparser2
    const events = [];
    const parser = new RT.Parser({ onopentag: (n, a) => events.push(`<${n}${a.class ? '.' + a.class : ''}>`), ontext: (t) => { if (t.trim()) events.push(t.trim()); }, onclosetag: (n) => events.push(`</${n}>`), onend: () => events.push('END') }, { decodeEntities: true });
    parser.write('<div class="a"><p>Hi &amp; bye</p><br></div>'); parser.end();
    ok('htmlparser2 events', events.join(' ') === '<div.a> <p> Hi & bye </p> <br> </br> </div> END', events.join(' '));
    const ev2 = []; const p2 = new RT.Parser({ onopentag: (n) => ev2.push(n) }); p2.write('<html><head><title>t</title></head><body><p>x</p></body></html>'); p2.end();
    ok('htmlparser2 full document tags', ev2.join(',') === 'html,head,title,body,p', ev2.join(','));
    // ---- dayjs
    const d = RT.dayjs('2024-03-05 14:07:09');
    ok('dayjs format', d.format('YYYY-MM-DD HH:mm:ss') === '2024-03-05 14:07:09' && d.format('LL') === 'March 5, 2024' && d.format('LLL') === 'March 5, 2024 2:07 PM' && d.format('MMM D, YY') === 'Mar 5, 24');
    ok('dayjs iso', RT.dayjs('2024-03-05T10:00:00Z').toISOString() === '2024-03-05T10:00:00.000Z');
    ok('dayjs subtract', d.subtract(2, 'days').format('YYYY-MM-DD') === '2024-03-03' && d.subtract(3, 'hours').format('HH') === '11' && d.subtract(1, 'month').format('YYYY-MM') === '2024-02' && d.subtract(2, 'years').format('YYYY') === '2022');
    ok('dayjs fromNow', RT.dayjs(Date.now() - 3 * 86400000).fromNow() === '3 days ago' && RT.dayjs(Date.now() + 90000).fromNow() === 'in 2 minutes' && RT.dayjs().fromNow() === 'a few seconds ago');
    ok('dayjs custom parse', RT.dayjs('05/03/2024', 'DD/MM/YYYY').format('YYYY-MM-DD') === '2024-03-05' && RT.dayjs('Mar 5, 2024', 'MMM D, YYYY').isValid());
    ok('dayjs invalid', !RT.dayjs('nonsense').isValid() && RT.dayjs('nonsense').format('LL') === 'Invalid Date');
    ok('dayjs unix/valueOf/diff', RT.dayjs.unix(100).valueOf() === 100000 && RT.dayjs('2024-03-05').diff(RT.dayjs('2024-03-01'), 'day') === 4);
    ok('dayjs default export', RT.dayjs.default === RT.dayjs);
    return out;
  });
  let fail = 0;
  for (const [name, pass, note] of results) { console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${!pass && note ? ` → ${note}` : ''}`); if (!pass) fail++; }
  console.log(`\n${results.length - fail}/${results.length} passed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
