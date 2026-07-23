/* ============================================================================
   Namma Bazar — Shared Supabase Client

   Load order matters. Every page must have these two lines, in this order,
   BEFORE its own <script> block:

     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
     <script src="supabase-client.js"></script>
   ============================================================================ */

/* ---------------------------------------------------------------------------
   STEP 1 — PUT YOUR PROJECT VALUES HERE

   Supabase Dashboard -> Settings -> API
     Project URL  ->  SUPABASE_URL
     anon public  ->  SUPABASE_ANON_KEY

   The anon key is meant to be public - it is in every visitor's browser.
   Your data is protected by the Row Level Security policies in the
   migrations, not by hiding this key.

   NEVER put the service_role key here. It bypasses all security.
--------------------------------------------------------------------------- */
const SUPABASE_URL = 'https://ycffcsbadcgenttzwfdb.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InljZmZjc2JhZGNnZW50dHp3ZmRiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ1MzEyNzMsImV4cCI6MjEwMDEwNzI3M30.KSqo0mm8QSCY9ngQR_STHtsAp2xLWUiJ-RFgE7ulAAE';


/* ---------------------------------------------------------------------------
   Startup checks.

   Without these, a missing library or an unedited key produces
   "supabaseClient is not defined" on some later line, which points at the
   wrong place entirely. These fail loudly, at the real cause, with the fix.
--------------------------------------------------------------------------- */
function nbFatal(title, detail){
  console.error('[Namma Bazar] ' + title + '\n' + detail);
  function paint(){
    if(document.getElementById('nb-config-error')) return;
    var bar = document.createElement('div');
    bar.id = 'nb-config-error';
    bar.setAttribute('role', 'alert');
    bar.style.cssText =
      'position:fixed;left:0;right:0;top:0;z-index:99999;background:#B01212;color:#fff;' +
      'padding:14px 18px;font:14px/1.5 Inter,Arial,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.3)';
    bar.innerHTML = '<strong>Setup problem: ' + title + '</strong><br>' +
      '<span style="font-size:13px;opacity:.95">' + detail + '</span>';
    document.body.appendChild(bar);
  }
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', paint);
  } else { paint(); }
}

// (a) Did the Supabase library actually load?
if(typeof window.supabase === 'undefined' || !window.supabase.createClient){
  nbFatal(
    'The Supabase library did not load.',
    'Check that this line appears BEFORE supabase-client.js on the page, and that you are ' +
    'online:<br><code>&lt;script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"&gt;&lt;/script&gt;</code>' +
    '<br>If you opened this file by double-clicking it, serve it over http instead — ' +
    'GitHub Pages, or <code>python3 -m http.server</code> in the project folder.'
  );
  throw new Error('Supabase library missing - see the message at the top of the page.');
}

// (b) Were the placeholder values replaced?
if(SUPABASE_URL.indexOf('YOUR-PROJECT-REF') !== -1 || SUPABASE_ANON_KEY.indexOf('YOUR-ANON') !== -1){
  nbFatal(
    'supabase-client.js has not been configured yet.',
    'Open <code>supabase-client.js</code> and replace SUPABASE_URL and SUPABASE_ANON_KEY with the ' +
    'values from Supabase Dashboard -> Settings -> API. Nothing on the site can load until you do.'
  );
  throw new Error('supabase-client.js still contains placeholder values.');
}

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Also expose it on window. A `const` at the top level of one script tag is
// reachable from another, but not from inline onclick="" handlers, which run
// in a different scope - and several pages use those.
window.supabaseClient = supabaseClient;

/* ============================================================================
   SHARED: real "Deliver to" location label

   Every customer-facing page has a <strong id="loc-label"> in the header.
   It was hardcoded to a fixed locality in another city on all 14 pages and
   nothing ever updated it — shown to users of a marketplace that serves
   Sagar, Karnataka only.

   This resolves it from real data on every page that includes this file:
     1. the signed-in customer's default delivery address, else
     2. the active launch city from the `cities` table.
   ============================================================================ */
async function initDeliveryLocationLabel(){
  const targets = document.querySelectorAll('#loc-label, #loc-label-m');
  if(!targets.length) return;

  const setLabel = text => targets.forEach(el => { el.textContent = text; });

  try {
    const { data: { session } } = await supabaseClient.auth.getSession();

    if(session){
      const { data: addr } = await supabaseClient
        .from('customer_addresses')
        .select('area, pincode, cities(name, state)')
        .eq('customer_id', session.user.id)
        .eq('is_default', true)
        .maybeSingle();

      if(addr){
        const city = addr.cities && addr.cities.name;
        setLabel([addr.area, city].filter(Boolean).join(', ') || city || 'Sagar');
        return;
      }
    }

    const { data: city } = await supabaseClient
      .from('cities')
      .select('name, state')
      .eq('is_active', true)
      .order('launched_at')
      .limit(1)
      .maybeSingle();

    setLabel(city ? `${city.name}, ${city.state}` : 'Sagar, Karnataka');
  } catch(err){
    console.error('Could not resolve delivery location:', err);
    setLabel('Sagar, Karnataka');
  }
}

if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', initDeliveryLocationLabel);
} else {
  initDeliveryLocationLabel();
}
