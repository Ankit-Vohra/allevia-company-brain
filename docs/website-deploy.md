# Putting the website online

Nothing here has been done. The site is built and checked, not published: no server was touched, no AWS call was made, and no
domain was bought or registered. This page is what to do when you decide to publish.

## What you are serving

A folder of plain files. No server code, no Docker, no database.

```sh
cd site
npm ci                      # once
npm run build               # type-checks, then writes site/dist/
npm run check               # build + dead-link check + the list of placeholders still to fill
```

`site/dist/` is the whole site: 12 pages (`/`, `/product/`, `/demo/`, `/pricing/`, `/security/`, `/faq/`,
`/about/`, `/contact/`, `/privacy/`, `/terms/`, `/data-deletion/`, `/cookies/`), `404.html`, `sitemap.xml`, `robots.txt`,
`site.webmanifest`, the icons, and `assets/` and `img/`. About 4 MB, most of it the two short videos and the pictures. Every
page works with JavaScript switched off (prices then show in US dollars).

The only script is `assets/main-*.js` (under 2 KB): the pause button on the loops and the contents list on
the legal pages. There are no cookies, no analytics and nothing is loaded from another company's servers, so the site works under
this strict policy (checked against every page):

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self';
media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

(`'unsafe-inline'` is for style attributes only, which colour the office rooms.)

## Before you publish: the checklist

1. **Fill in `site/src/company.ts`.** Every empty value shows on the page as a yellow `TODO(founder)` mark. `npm run
   check:placeholders` lists them; `npm run check:placeholders -- --strict` fails while any remain, so use it as the last gate.
2. **Confirm the domain** in `site/src/config.ts` (`SITE_URL`, now `https://allevia-ai.in`). It sets every canonical link, the
   social cards, the sitemap and the structured data.
3. **Set `DEMO_URL`** in `site/src/config.ts` when the public demo is hosted (below). Empty hides every "Try the live demo" button.
4. **Have a lawyer read** the privacy policy, the terms, the data-deletion page and the cookie note. They were written from the code and
   the product design, not from legal advice.
5. Rebuild, run `npm run check`, and look at the pages once at phone width.

## Serving it from the same small AWS instance

Any web server will do. With **Caddy** (certificates and renewal are automatic once DNS points at the instance):

```
allevia-ai.in, www.allevia-ai.in {
	root * /srv/allevia-site
	encode zstd gzip
	file_server
	handle_errors {
		rewrite * /404.html
		file_server
	}
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
		Permissions-Policy "camera=(), microphone=(), geolocation=()"
		Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
	}
	@static path /assets/* /img/*
	header @static Cache-Control "public, max-age=31536000, immutable"
}
```

`/assets/` file names carry a hash, so they can be cached for a year. `/img/` file names are stable: if you replace a picture, give
the new one a new name or shorten that cache. Pages should not be cached for long (the Caddy default is fine).

Copy the files over with `rsync -av --delete site/dist/ <the instance>:/srv/allevia-site/` (or `scp -r`). With **nginx** the equivalent
is `root /srv/allevia-site; error_page 404 /404.html; try_files $uri $uri/ =404;` plus the same headers.

Do not put the site and the app behind one hostname. The app (the API and the web app, port 8787 on that machine) serves its own
pages; give it its own name (`demo.` below) in its own server block, proxying to `127.0.0.1:8787`.

## Or from any static host

Upload `site/dist/` to S3 with CloudFront, Cloudflare Pages, Netlify or similar. Set the publish folder to `site/dist` and the build
command to `cd site && npm ci && npm run build`. Folder-style addresses (`/privacy/`) need the host to serve `index.html` for a folder,
which all of them do. Use `404.html` as the not-found page, and add the headers above where the host allows.

## The public demo, when you want one

The real app already has a public read-only mode, and the demo page describes exactly that (see the README, "Public demo with Docker"):

```sh
docker compose up -d --build        # the app in public mode on 127.0.0.1:8787, with FalkorDB
docker compose exec app tsx scripts/seed-demo.ts demo_seed --register     # a made-up sample company
```

Public mode alone shows every business on that server, read-only. So host the demo on a server with no customer in it, or turn
on owner links (`ALLEVIA_AUTH=1`) and mark only the demo business with `npm run cli -- auth:demo demo_seed`: then a stranger
sees only the businesses marked as demos. `docs/tenant-isolation.md` has the details and the open items (the database has no
password yet, so keep its port private).

Put it behind its own name and TLS, set `DEMO_URL` to that address, rebuild and republish the site. Decide which businesses the demo
loads (`/demo/` has a `TODO(founder)` for it): a customer's data must never go in. The app sends `X-Frame-Options`, so the site
links to the demo and does not embed it.

## DNS records

You need these at whoever holds the domain. Replace the placeholders; none of this has been created.

| Name | Type | Value | For |
|---|---|---|---|
| `allevia-ai.in` (the bare domain) | `A` (and `AAAA` if the instance has IPv6) | the instance's public IP, ideally an Elastic IP so it survives a restart | the site on the instance |
| `www` | `CNAME` | `allevia-ai.in` | `www` goes to the same place (redirect it to the bare name in the server) |
| `demo` | `A` or `CNAME` | the machine running the app | only when the demo is hosted |
| the bare domain | `MX` | your mail provider's records | the contact, support, privacy and security mailboxes |
| the bare domain | `TXT` | the provider's SPF line, for example `v=spf1 include:<provider> ~all` | mail from you is trusted |
| `<selector>._domainkey` | `TXT` or `CNAME` | what the provider gives you (DKIM) | same |
| `_dmarc` | `TXT` | `v=DMARC1; p=none; rua=mailto:<a mailbox you read>`, tightened to `quarantine` later | same |
| the bare domain | `CAA` | `0 issue "letsencrypt.org"` (optional) | only that authority may issue certificates |

For a static host instead of the instance, use the host's own target in place of the `A` record: a `CNAME` (or `ALIAS`/`ANAME` on the
bare domain) to the name it gives you.

The mailboxes the site names are set in `site/src/company.ts` (`email.general`, `email.support`, `email.privacy`, `email.security`).
Make them real before publishing: the privacy and data-deletion pages promise that mail to the privacy address is answered, and Meta and
Google may write to it.

## What to give Meta and Google (after publishing)

- Privacy policy URL: `<SITE_URL>/privacy/`
- Terms of service URL: `<SITE_URL>/terms/`
- User data deletion (instructions URL, not a callback): `<SITE_URL>/data-deletion/`
- Google OAuth consent screen: the app home page `<SITE_URL>/`, the privacy policy above, and the scopes listed in its "Google user
  data and limited use" section (Search Console and Analytics read-only; Business Profile `business.manage`).
- Instagram API with Instagram login: the permissions in "Instagram and Meta data" (`instagram_business_basic`,
  `instagram_business_manage_insights`). If the App Review submission asks for different ones, change the policy first.

Keep those three addresses stable. Moving a page later means a redirect from the old address.
