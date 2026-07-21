/* ============================================================================
   Namma Bazar — Shared Supabase Client
   Include the Supabase CDN script FIRST, then this file, then the page's
   own <script> block:

     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
     <script src="supabase-client.js"></script>

   One client, reused by every page — register.html and seller-login.html
   today; seller-dashboard.html and seller-add-product.html can include the
   same two lines when they're connected in a later phase.
   ============================================================================ */

// TODO: replace with your project's real values — Supabase Dashboard →
// Settings → API. The anon key is safe to expose client-side; every table
// it can touch is protected by the RLS policies already in the migrations.
const SUPABASE_URL = 'https://https://ycffcsbadcgenttzwfdb.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InljZmZjc2JhZGNnZW50dHp3ZmRiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ1MzEyNzMsImV4cCI6MjEwMDEwNzI3M30.KSqo0mm8QSCY9ngQR_STHtsAp2xLWUiJ-RFgE7ulAAE';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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
