<script lang="ts">
  import '@fontsource-variable/stix-two-text';
  import { onDestroy, onMount } from 'svelte';
  import { detectOs, latestDownload, OS_LABEL, type Os, osOrder, releasesPage } from '../lib/downloads.js';
  import { SOURCE_URL } from '../lib/links.js';
  import { BookOpen, CloudUpload, Cpu, Download, FolderOpen, Lock, Users, WifiOff } from '../ui/icons.js';
  import Icon from '../ui/Icon.svelte';
  import Logo from '../ui/Logo.svelte';

  const detected = detectOs(navigator.userAgent, navigator.platform);
  const order = osOrder(detected);
  const primaryOs = order[0] as Os;
  const others = order.slice(1);
  const releases = releasesPage(SOURCE_URL);
  let resolving = $state<Os | null>(null);

  async function download(e: MouseEvent, os: Os) {
    e.preventDefault();
    resolving = os;
    location.href = await latestDownload(os, SOURCE_URL);
    resolving = null;
  }

  function scrollTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Hero demo: a co-author types; the PDF catches up when the word is done.
  const words = ['message passing', 'graph attention'];
  let typed = $state(words[0] as string);
  let compiled = $state(words[0] as string);
  let timer = 0;
  onMount(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let w = 0;
    let i = typed.length;
    let phase: 'hold' | 'del' | 'type' = 'hold';
    let hold = 16;
    timer = window.setInterval(() => {
      const word = words[w] as string;
      if (phase === 'hold') {
        if (--hold <= 0) phase = 'del';
      } else if (phase === 'del') {
        typed = word.slice(0, --i);
        if (i === 0) {
          w = (w + 1) % words.length;
          phase = 'type';
        }
      } else {
        typed = word.slice(0, ++i);
        if (i >= word.length) {
          compiled = word;
          phase = 'hold';
          hold = 22;
        }
      }
    }, 110);
  });
  onDestroy(() => clearInterval(timer));

  const features = [
    { icon: Users, title: 'Live co-writing', text: "See each co-author's cursor in their own color, follow them through the document, and never merge by hand." },
    { icon: WifiOff, title: 'Works offline', text: 'Keep writing on a train. When you reconnect, changes merge paragraph by paragraph.' },
    { icon: Cpu, title: 'Compiled by the hive', text: 'The fastest computer online builds the PDF and sends it to everyone. If it leaves, the next one takes over.' },
    { icon: Lock, title: 'Private by design', text: 'Sources travel encrypted between co-authors’ devices. The server only knows who is in the project.' },
    { icon: CloudUpload, title: 'GitHub backup', text: 'Commit to your own repository after a burst of edits, or when you stop typing for a while.' },
    { icon: FolderOpen, title: 'Bring your project', text: 'Import an Overleaf .zip or a folder, or keep the project mirrored to a folder your other tools can read.' },
  ];
</script>

<div class="landing" data-testid="landing">
  <header class="nav">
    <a class="brand" href="#/" aria-label="HiveTeX home"><Logo /></a>
    <nav aria-label="Page sections" class="links">
      <button type="button" class="link" onclick={() => scrollTo('features')}>Features</button>
      <button type="button" class="link" onclick={() => scrollTo('how')}>How it works</button>
      <button type="button" class="link" onclick={() => scrollTo('download')}>Download</button>
      <a class="link" href={SOURCE_URL} target="_blank" rel="noreferrer noopener">Source code</a>
    </nav>
    <span class="sp"></span>
    <a class="link signin" href="#/login">Sign in</a>
    <a class="btn primary" href="#/register">Create free account</a>
  </header>

  <main>
    <section class="hero" aria-labelledby="hero-title">
      <div class="pitch">
        <p class="eyebrow">Free and open source LaTeX editor</p>
        <h1 id="hero-title">Write your paper <em>together</em>, on your own machines.</h1>
        <p class="lead">
          Co-authors edit the same document live, keep writing offline, and the fastest computer in the group compiles the PDF for everyone.
          Your sources stay on your devices.
        </p>
        <div class="ctas">
          <a class="btn primary lg" href="#/register">Create free account</a>
          <a class="btn lg" href={releases} onclick={(e) => download(e, primaryOs)} data-testid="download-{primaryOs}">
            <Icon icon={Download} size={18} />{resolving === primaryOs ? 'Finding the latest version…' : `Download for ${OS_LABEL[primaryOs]}`}
          </a>
        </div>
        <p class="small">
          Also for
          {#each others as os, i (os)}<a href={releases} onclick={(e) => download(e, os)} data-testid="download-{os}">{OS_LABEL[os]}</a>{i === 0 ? ' and ' : ''}{/each}
          · AGPL-3.0 · No credit card, no storage quota
        </p>
      </div>

      <figure class="shot" aria-label="The HiveTeX editor: LaTeX source next to the compiled PDF while a co-author types">
        <div class="shot-bar">
          <span class="faces" aria-hidden="true"><span style:--av="var(--p1)">FC</span><span style:--av="var(--p2)">AL</span><span style:--av="var(--p3)">KT</span></span>
          <span>main.tex · 3 writing now</span>
          <span class="ok"><span class="dot"></span>PDF up to date</span>
        </div>
        <div class="shot-body">
          <div class="src" aria-hidden="true">
            <div class="row"><span class="ln">1</span><span class="code"><span class="c">\title</span><span class="b">{'{'}</span>Graph Networks for Protein Folding<span class="b">{'}'}</span></span></div>
            <div class="row"><span class="ln">2</span><span class="code"><span class="c">\author</span><span class="b">{'{'}</span>F. Cunico, A. Lindqvist, K. Tanaka<span class="b">{'}'}</span></span></div>
            <div class="row"><span class="ln">3</span><span class="code"></span></div>
            <div class="row"><span class="ln">4</span><span class="code"><span class="c">\begin</span><span class="b">{'{'}</span><span class="e">abstract</span><span class="b">{'}'}</span></span></div>
            <div class="row"><span class="ln">5</span><span class="code">We predict tertiary structure from</span></div>
            <div class="row"><span class="ln">6</span><span class="code">contact maps using {typed}<span class="caret"><i>Ada</i></span></span></div>
            <div class="row"><span class="ln">7</span><span class="code"><span class="c">\end</span><span class="b">{'{'}</span><span class="e">abstract</span><span class="b">{'}'}</span></span></div>
            <div class="row"><span class="ln">8</span><span class="code"></span></div>
            <div class="row"><span class="ln">9</span><span class="code"><span class="c">\section</span><span class="b">{'{'}</span>Introduction<span class="b">{'}'}</span></span></div>
            <div class="row"><span class="ln">10</span><span class="code">Folding is <span class="m">$\Delta G$</span>-driven <span class="c">\cite</span><span class="b">{'{'}</span>anfinsen73<span class="b">{'}'}</span>.</span></div>
          </div>
          <div class="pdf" aria-hidden="true">
            <div class="page">
              <h4>Graph Networks for Protein Folding</h4>
              <div class="au">F. Cunico · A. Lindqvist · K. Tanaka</div>
              <div class="abs"><b>Abstract.</b> We predict tertiary structure from contact maps using {compiled} over residue graphs.</div>
              <h5>1&nbsp;&nbsp;Introduction</h5>
              <p>Folding is <i>ΔG</i>-driven [1]. Most residues settle into a small set of local motifs, which a graph model can learn from contact maps alone.</p>
              <p>We describe the model in Section 2 and the training data in Section 3.</p>
            </div>
          </div>
        </div>
      </figure>
    </section>

    <section class="band" id="features" aria-labelledby="features-title">
      <h2 id="features-title">Built for papers with more than one author</h2>
      <p class="sub">Everything Overleaf users expect, without handing your unpublished work to a cloud.</p>
      <ul class="features">
        {#each features as f (f.title)}
          <li>
            <h3><Icon icon={f.icon} size={18} />{f.title}</h3>
            <p>{f.text}</p>
          </li>
        {/each}
      </ul>
    </section>

    <section class="band" id="how" aria-labelledby="how-title">
      <h2 id="how-title">From blank page to shared PDF</h2>
      <p class="sub">Three steps, and the second one takes about ten seconds.</p>
      <ol class="steps">
        <li><span class="n">Step 1</span><h3>Start from a template</h3><p>Article, thesis, Beamer slides or a CV. Each one compiles before you change a word.</p></li>
        <li><span class="n">Step 2</span><h3>Share the project ID</h3><p>Send an ID such as <code>gnn-folding-2026</code> and its password. You choose who can edit and who can only read.</p></li>
        <li><span class="n">Step 3</span><h3>Write together</h3><p>Edits appear as they are typed. The PDF refreshes for everyone after each compile.</p></li>
      </ol>
    </section>

    <section class="band" aria-label="Who it is for">
      <div class="duo">
        <div>
          <h3>New to LaTeX?</h3>
          <ul>
            <li>A toolbar for headings, lists, math, figures and citations</li>
            <li>Templates that already compile</li>
            <li>Error messages in plain language, with a button to fix the common ones</li>
            <li>A short tour the first time you open a project</li>
          </ul>
        </div>
        <div>
          <h3>Live in LaTeX already?</h3>
          <ul>
            <li>A command palette for every action (<kbd class="kbd">Ctrl</kbd> <kbd class="kbd">K</kbd>)</li>
            <li>Vim or Emacs keys, SyncTeX both ways, outline jump</li>
            <li>Your own TeX Live, or a built-in compiler that installs itself</li>
            <li>Mirror the project to a folder for Git, scripts or your AI tools</li>
          </ul>
        </div>
      </div>
    </section>

    <section class="band dl" id="download" aria-labelledby="download-title">
      <div>
        <h2 id="download-title">Use it in the browser or install it</h2>
        <p class="sub">The desktop app adds folder mirroring and a full TeX installation that sets itself up. Both work on the same projects.</p>
      </div>
      <div class="dl-buttons">
        {#each order as os, i (os)}
          <a class="btn {i === 0 ? '' : 'quiet'}" href={releases} onclick={(e) => download(e, os)}><Icon icon={Download} />{OS_LABEL[os]}</a>
        {/each}
        <a class="btn quiet" href="#/register"><Icon icon={BookOpen} />Open in the browser</a>
      </div>
    </section>
  </main>

  <footer class="foot">
    <span>HiveTeX · AGPL-3.0-or-later</span>
    <span class="sp"></span>
    <a href={SOURCE_URL} target="_blank" rel="noreferrer noopener">Source code</a>
    <a href={releases} target="_blank" rel="noreferrer noopener">Releases</a>
    <a href="#/login">Sign in</a>
  </footer>
</div>

<style>
  .landing {
    --page-pad: clamp(16px, 5vw, 56px);
    min-height: 100%;
    background: var(--paper);
    color: var(--ink);
  }
  .nav {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 24px;
    padding: 16px var(--page-pad);
    max-width: 1280px;
    margin: 0 auto;
  }
  .brand {
    text-decoration: none;
  }
  .links {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 20px;
  }
  .sp {
    flex: 1;
  }
  .link {
    min-height: 0;
    padding: 4px 0;
    border: 0;
    background: none;
    color: var(--muted);
    font-weight: 500;
    text-decoration: none;
  }
  .link:hover {
    color: var(--ink);
    background: none;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: var(--control-h);
    padding: 0 14px;
    border: 1px solid var(--line-strong);
    border-radius: var(--r-m);
    background: var(--surface);
    color: var(--ink);
    font-weight: 500;
    text-decoration: none;
    white-space: nowrap;
  }
  .btn:hover {
    background: var(--sunken);
  }
  .btn.primary {
    background: var(--honey);
    border-color: var(--honey);
    color: var(--on-honey);
    font-weight: 600;
  }
  .btn.primary:hover {
    background: var(--honey-hover);
  }
  .btn.lg {
    min-height: 46px;
    padding: 0 20px;
    font-size: var(--text-lg);
    border-radius: var(--r-l);
  }
  .btn.quiet {
    border-color: var(--line);
  }

  .hero {
    display: grid;
    grid-template-columns: minmax(0, 5fr) minmax(0, 6fr);
    gap: 48px;
    align-items: center;
    padding: 32px var(--page-pad) 64px;
    max-width: 1280px;
    margin: 0 auto;
  }
  .eyebrow {
    margin: 0;
    font-size: var(--text-xs);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--honey-ink);
    font-weight: 600;
  }
  h1 {
    font: 400 clamp(36px, 5vw, 56px) / 1.04 var(--font-display);
    letter-spacing: -0.015em;
    margin: 14px 0 18px;
  }
  h1 em {
    font-style: italic;
    color: var(--honey-ink);
  }
  .lead {
    font-size: 17px;
    line-height: 1.6;
    color: var(--muted);
    margin: 0 0 26px;
    max-width: 46ch;
  }
  .ctas {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }
  .small {
    margin: 14px 0 0;
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .shot {
    margin: 0;
    border: 1px solid var(--line);
    border-radius: var(--r-l);
    background: var(--surface);
    box-shadow: var(--shadow-2);
    overflow: hidden;
    min-width: 0;
  }
  .shot-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 36px;
    padding: 0 12px;
    border-bottom: 1px solid var(--line);
    font-size: 12.5px;
    color: var(--muted);
  }
  .faces {
    display: inline-flex;
    padding-left: 4px;
  }
  .faces span {
    width: 24px;
    height: 24px;
    margin-left: -4px;
    border-radius: 50%;
    display: inline-grid;
    place-items: center;
    background: var(--av);
    color: var(--on-presence);
    font: 600 9.5px/1 var(--font-ui);
    box-shadow: 0 0 0 2px var(--surface);
  }
  .shot-bar > span:nth-child(2) {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .shot-bar .ok {
    flex: none;
    white-space: nowrap;
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px;
    border-radius: 999px;
    background: var(--ok-soft);
    color: var(--ok);
    font-weight: 500;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
  }
  .shot-body {
    display: grid;
    grid-template-columns: 1fr 1fr;
    min-height: 330px;
  }
  .src {
    padding: 14px 14px 14px 0;
    font: 12.5px/1.75 var(--font-code);
    border-right: 1px solid var(--line);
    overflow: hidden;
    color: var(--ink);
  }
  /* One row per source line: wrapped text stays to the right of its line number. */
  .src .row {
    display: grid;
    grid-template-columns: 36px minmax(0, 1fr);
    align-items: start;
    gap: 0;
    min-height: 1.75em;
  }
  .ln {
    padding-right: 12px;
    text-align: right;
    color: var(--faint);
  }
  .code {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .c {
    color: var(--syn-cmd);
  }
  .e {
    color: var(--syn-env);
  }
  .m {
    color: var(--syn-math);
  }
  .b {
    color: var(--syn-brace);
  }
  .caret {
    position: relative;
    display: inline-block;
    width: 2px;
    height: 1.2em;
    vertical-align: -3px;
    background: var(--p2);
    animation: blink 1s steps(1) infinite;
  }
  .caret i {
    position: absolute;
    bottom: 100%;
    left: -1px;
    padding: 2px 4px;
    border-radius: 3px 3px 3px 0;
    background: var(--p2);
    color: var(--on-presence);
    font: 600 9.5px/1 var(--font-ui);
    font-style: normal;
    white-space: nowrap;
  }
  @keyframes blink {
    50% {
      opacity: 0.2;
    }
  }
  .pdf {
    background: var(--pdf-desk);
    padding: 18px;
    display: grid;
    place-items: start center;
  }
  /* The page is paper in both themes. */
  .page {
    width: 100%;
    max-width: 280px;
    aspect-ratio: 1 / 1.294;
    padding: 26px 24px;
    background: var(--pdf-paper);
    color: #121212;
    font: 8.5px/1.45 var(--font-display);
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.18);
  }
  .page h4 {
    font: 600 13px/1.2 var(--font-display);
    text-align: center;
    margin: 0 0 4px;
  }
  .page .au {
    text-align: center;
    margin-bottom: 10px;
  }
  .page .abs {
    margin: 0 14px 8px;
    font-size: 7.5px;
    text-align: justify;
  }
  .page h5 {
    font: 600 9.5px/1.2 var(--font-display);
    margin: 8px 0 3px;
  }
  .page p {
    margin: 0 0 4px;
    text-align: justify;
    text-indent: 1em;
  }

  .band {
    padding: 56px var(--page-pad);
    border-top: 1px solid var(--line);
    max-width: 1280px;
    margin: 0 auto;
  }
  h2 {
    font: 400 clamp(26px, 3.2vw, 34px) / 1.15 var(--font-display);
    margin: 0 0 8px;
  }
  .sub {
    color: var(--muted);
    margin: 0 0 32px;
    font-size: var(--text-lg);
    max-width: 60ch;
  }
  .features {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 32px 40px;
  }
  .features li {
    display: grid;
    gap: 6px;
    align-content: start;
  }
  .features h3 {
    margin: 0;
    font-size: var(--text-lg);
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .features h3 :global(svg) {
    color: var(--honey-ink);
  }
  .features p {
    margin: 0;
    color: var(--muted);
    max-width: 44ch;
  }
  .steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    border: 1px solid var(--line);
    border-radius: var(--r-l);
    background: var(--surface);
    overflow: hidden;
  }
  .steps li {
    padding: 22px 24px;
    display: grid;
    gap: 8px;
    align-content: start;
    border-left: 1px solid var(--line);
    margin-left: -1px;
  }
  .steps .n {
    font: 600 12px/1 var(--font-code);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--honey-ink);
  }
  .steps h3 {
    margin: 0;
    font-size: var(--text-lg);
  }
  .steps p {
    margin: 0;
    color: var(--muted);
  }
  .steps code {
    font-size: 12.5px;
    background: var(--sunken);
    padding: 1px 5px;
    border-radius: var(--r-s);
  }
  .duo {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 24px;
  }
  .duo > div {
    padding: 24px 26px;
    border-radius: var(--r-l);
    background: var(--surface);
    border: 1px solid var(--line);
    display: grid;
    gap: 10px;
    align-content: start;
  }
  .duo h3 {
    margin: 0;
    font: 600 20px/1.2 var(--font-display);
  }
  .duo ul {
    margin: 0;
    padding-left: 18px;
    color: var(--muted);
    display: grid;
    gap: 4px;
  }
  .dl {
    display: flex;
    flex-wrap: wrap;
    gap: 16px 40px;
    align-items: center;
    justify-content: space-between;
  }
  .dl .sub {
    margin: 0;
  }
  .dl-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }
  .foot {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 24px;
    padding: 24px var(--page-pad);
    border-top: 1px solid var(--line);
    color: var(--muted);
    font-size: var(--text-sm);
    max-width: 1280px;
    margin: 0 auto;
  }
  .foot a {
    color: var(--muted);
  }

  @media (max-width: 900px) {
    .hero {
      grid-template-columns: minmax(0, 1fr);
      gap: 32px;
    }
  }
  @media (max-width: 560px) {
    .shot-body {
      grid-template-columns: minmax(0, 1fr);
    }
    .pdf {
      display: none;
    }
    .links {
      display: none;
    }
    .signin {
      margin-left: auto;
    }
    .nav .sp {
      display: none;
    }
  }
</style>
