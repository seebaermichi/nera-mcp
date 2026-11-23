import { z } from 'zod'

/** What every prompt tells a model that has never heard of Nera. */
const ABOUT_NERA = 'Nera is a static site generator: a site is a folder of Markdown pages (pages/, each with YAML frontmatter that names its `layout`), Pug layouts and a config/app.yaml, built into plain HTML in public/. Use only the Nera tools of this server for it; do not write HTML files by hand and do not run commands yourself.'

const VALIDATE_AND_PREVIEW = 'Call validate and fix every error it reports (each message says how), then build, then preview and give the user the preview URL.'

function userMessage(text) {
    return { messages: [{ role: 'user', content: { type: 'text', text } }] }
}

/** A `label: value` line for the prompt text when the user gave a value, else an empty string. */
function given(label, value) {
    return value ? `\n${label}: ${value}` : ''
}

const siteArg = z.string().optional().describe('The site folder as list_sites returns it; leave out to choose one with list_sites.')

/**
 * Registers the four task prompts: new business website, new blog, add a
 * page, put my site online.
 *
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 */
export function registerPrompts(server) {
    server.registerPrompt('new_business_website', {
        title: 'New business website',
        description: 'Create a website for a small business with Nera: home, about, services, contact, imprint and privacy.',
        argsSchema: {
            business: z.string().optional().describe('What the business is and does, e.g. "a bakery in Hamburg with a café".'),
            folder: z.string().optional().describe('The folder name for the new site, e.g. `my-bakery`.'),
        },
    }, ({ business, folder }) => userMessage(`Create a website for my business with Nera.${given('The business', business)}${given('Folder', folder)}

${ABOUT_NERA}

Steps:
1. Call list_sites. If a site for this business already exists, ask me whether to work on it instead of creating a new one.
2. Call list_starters and pick the \`business\` starter (or \`portfolio\` if the business shows its work in pictures).
3. Call create_site with that starter, a short lowercase folder name${folder ? ` (\`${folder}\`)` : ''}, the business name as \`title\` and the site language as \`lang\`.
4. Call get_site, then read_page on each sample page and rewrite it with write_page for my business, keeping each page's \`layout\` in its frontmatter. Ask me for facts you do not know (address, opening hours, services, prices) instead of inventing them; leave a clear placeholder where I must fill something in.
5. Fill in the imprint and privacy pages' placeholders only with what I told you, and tell me which legal details are still missing.
6. ${VALIDATE_AND_PREVIEW}
7. Tell me which pages exist and that put_site_online publishes the site when I am happy with it.`))

    server.registerPrompt('new_blog', {
        title: 'New blog',
        description: 'Create a blog with Nera: posts with tags, an archive, a feed and a sitemap.',
        argsSchema: {
            topic: z.string().optional().describe('What the blog is about, e.g. "travel and photography".'),
            folder: z.string().optional().describe('The folder name for the new site, e.g. `my-blog`.'),
        },
    }, ({ topic, folder }) => userMessage(`Create a blog for me with Nera.${given('Topic', topic)}${given('Folder', folder)}

${ABOUT_NERA}

Steps:
1. Call list_sites. If a blog already exists, ask me whether to work on it instead of creating a new one.
2. Call list_starters and pick the \`blog\` starter.
3. Call create_site with it, a short lowercase folder name${folder ? ` (\`${folder}\`)` : ''}, the blog's name as \`title\` and its language as \`lang\`.
4. Call get_site and read_page on one sample post to see the frontmatter a post uses (title, date, tags, layout).
5. Replace the sample posts with write_page: one first post on my topic, written with me, using the same frontmatter fields and \`layout\`; delete the other samples with delete_page once I agree. Update the home and about pages.
6. ${VALIDATE_AND_PREVIEW}
7. Tell me how to add the next post (the add_page prompt does it) and that put_site_online publishes the blog.`))

    server.registerPrompt('add_page', {
        title: 'Add a page',
        description: 'Add a new page (or blog post) to an existing Nera site, in the style of its other pages.',
        argsSchema: {
            site: siteArg,
            topic: z.string().optional().describe('What the new page is about, e.g. "our new opening hours" or "a post about my trip to Lisbon".'),
        },
    }, ({ site, topic }) => userMessage(`Add a new page to my Nera site.${given('Site', site)}${given('The page', topic)}

${ABOUT_NERA}

Steps:
1. ${site ? `Call get_site with site \`${site}\`.` : 'Call list_sites; if there is more than one site, ask me which one. Then call get_site.'} Read the site's AGENTS.md resource (\`nera://site/<site>/AGENTS.md\`) if it has one.
2. Call read_page on an existing page of the same kind (a post for a post, a normal page otherwise) and copy its frontmatter fields and \`layout\`.
3. Choose a file name that fits the site's other pages (lowercase, hyphens, \`.md\`, in the same folder as its siblings) and write the page with write_page. Ask me for content you do not know.
4. If the site has a navigation config (e.g. config/navigation.yaml, see get_site's plugins and read_file), add the page there when it belongs in the menu, with write_file.
5. ${VALIDATE_AND_PREVIEW}`))

    server.registerPrompt('put_site_online', {
        title: 'Put my site online',
        description: 'Publish a Nera site on the web for free (GitHub Pages or Netlify), with no hosting knowledge needed.',
        argsSchema: { site: siteArg },
    }, ({ site }) => userMessage(`Put my Nera site online.${given('Site', site)}

${ABOUT_NERA}

Steps:
1. ${site ? `Use site \`${site}\`.` : 'Call list_sites; if there is more than one site, ask me which one.'}
2. Call validate and fix every error; then call build with \`check: true\` and tell me about accessibility, privacy and legal findings (an imprint and a privacy page are required for many sites, e.g. in Germany). Fix what you can with my consent.
3. Call publish for the site. It returns a short code and a GitHub web address: give me both and ask me to open the address, sign in to GitHub (or create a free account) and enter the code. Never ask me for a password or token.
4. After I confirm, call publish again for the same site until it reports the result, and give me the address where the site is now online. Tell me that later changes go online by calling publish again.`))
}

/** What the hosted prompts add: the site is a GitHub repository and changes wait on a draft. */
const ABOUT_HOSTED = 'Here each site is a GitHub repository of the user. write_page, write_file and delete_page commit to its draft branch nera-draft, one commit each with the message you pass; nothing goes live until publish merges the draft into main, which starts the site\'s deploy workflow once for all changes.'

const VALIDATE_AND_PUBLISH = 'Call validate and fix every error it reports (each message says how). Then ask me whether to put the changes live; when I agree, call publish, give me the address it reports and tell me the deploy takes a minute or two (preview shows how it went).'

const hostedSiteArg = z.string().optional().describe('The site as `owner/name`, as list_sites returns it; leave out to choose one with list_sites.')

/**
 * Registers the task prompts of the hosted mode, worded for its tools (write
 * → validate → publish, no build): add a page, put my site online. The
 * `new_*` prompts need `create_site`, which the hosted mode does not have.
 *
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 */
export function registerHostedPrompts(server) {
    server.registerPrompt('add_page', {
        title: 'Add a page',
        description: 'Add a new page (or blog post) to a Nera site in a GitHub repository, in the style of its other pages, and put it live.',
        argsSchema: {
            site: hostedSiteArg,
            topic: z.string().optional().describe('What the new page is about, e.g. "our new opening hours" or "a post about my trip to Lisbon".'),
        },
    }, ({ site, topic }) => userMessage(`Add a new page to my Nera site.${given('Site', site)}${given('The page', topic)}

${ABOUT_NERA}

${ABOUT_HOSTED}

Steps:
1. ${site ? `Call get_site with site \`${site}\`.` : 'Call list_sites; if there is more than one site, ask me which one. Then call get_site.'} Read the site's AGENTS.md with read_file if it has one.
2. Call read_page on an existing page of the same kind (a post for a post, a normal page otherwise) and copy its frontmatter fields and \`layout\`.
3. Choose a file name that fits the site's other pages (lowercase, hyphens, \`.md\`, in the same folder as its siblings) and write the page with write_page, with a short commit message. Ask me for content you do not know.
4. If the site has a navigation config (e.g. config/navigation.yaml, see get_site's plugins and read_file), add the page there when it belongs in the menu, with write_file.
5. ${VALIDATE_AND_PUBLISH}`))

    server.registerPrompt('put_site_online', {
        title: 'Put my site online',
        description: 'Put the unpublished changes of a Nera site in a GitHub repository live: check them, publish them in one deploy and report the live address.',
        argsSchema: { site: hostedSiteArg },
    }, ({ site }) => userMessage(`Put my Nera site online.${given('Site', site)}

${ABOUT_NERA}

${ABOUT_HOSTED}

Steps:
1. ${site ? `Use site \`${site}\`.` : 'Call list_sites; if there is more than one site, ask me which one.'} Call preview to see the live address, the last deploy and how many changes wait unpublished.
2. Call validate and fix every error with write_page or write_file; tell me what you changed.
3. Call publish for the site. It merges the draft into main in one push and returns the deploy run and the address. If it reports that the repository has no deploy workflow, tell me to run \`nera publish\` once in the site on my computer, which sets it up.
4. Call preview after a minute or two and tell me whether the deploy succeeded and where the site is live. Tell me that later changes go live by calling publish again.`))
}
