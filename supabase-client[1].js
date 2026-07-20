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
const SUPABASE_URL = 'https://YOUR-PROJECT-REF.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR-ANON-PUBLIC-KEY';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
