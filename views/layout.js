// The only HTML chrome in the project. Every page is layout(...) around a body string.

export function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function layout({ title, body, nav = '', head = '' }) {
  return `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/style.css">
${head}
</head>
<body>
<header class="top">
  <a class="brand" href="/">agent-ops</a>
  <nav>${nav}</nav>
</header>
<main>
${body}
</main>
</body>
</html>
`;
}

export function empty(message) {
  return `<p class="empty">${esc(message)}</p>`;
}
