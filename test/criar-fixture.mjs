// Gera feeds falsos com datas recentes para testar sem internet: npm test
import { writeFile, mkdir } from "node:fs/promises";
const d = h => new Date(Date.now() - h * 36e5).toUTCString();
await mkdir("test/fixture", { recursive: true });
await writeFile("test/fixture/gn.xml", `<?xml version="1.0"?><rss><channel>
<item><title>Manchete de teste &amp; acentuação São Paulo - ge</title><link>https://exemplo.com/a</link><pubDate>${d(1)}</pubDate><source url="https://ge.globo.com">ge</source></item>
<item><title><![CDATA[Segunda manchete com CDATA - Valor Econômico]]></title><link>https://exemplo.com/b</link><pubDate>${d(5)}</pubDate></item>
<item><title>Notícia velha que deve sumir - UOL</title><link>https://exemplo.com/c</link><pubDate>${d(80)}</pubDate></item>
</channel></rss>`);
await writeFile("test/fixture/rss.xml", `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><title>Steelers beat Browns in a defensive battle</title><link href="https://exemplo.com/s"/><published>${new Date(Date.now()-2*36e5).toISOString()}</published><summary type="html">&lt;p&gt;Recap with &lt;b&gt;HTML&lt;/b&gt; inside.&lt;/p&gt;</summary></entry>
</feed>`);
console.log("fixture ok");
