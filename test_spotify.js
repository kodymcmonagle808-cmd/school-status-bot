async function test() {
  const res = await fetch('https://open.spotify.com/embed/playlist/1Njedyj01AnBWG2MbUtCEt');
  const html = await res.text();
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextDataMatch) {
    const parsed = JSON.parse(nextDataMatch[1]);
    const entity = parsed?.props?.pageProps?.state?.data?.entity;
    if (entity && Array.isArray(entity.trackList)) {
      console.log(entity.trackList.map(t => t.title + ' - ' + t.subtitle).slice(0, 5));
    } else {
      console.log('No trackList found');
    }
  } else {
      console.log('No NEXT_DATA');
  }
}
test();

