/**
 * Team Manager Module — MaintMentor API
 * Handles organization/team CRUD, invites, and member management.
 * Phase 1: MVP for sales demos (no billing integration).
 */

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const { Resend } = require('resend');

// ─── Config ────────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rxzbnvvtzhgogeuhajvp.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || 'sb_secret_ZippXnI12gbtsKswpk0O4w_V1_A5EiU';
const APP_URL = process.env.APP_URL || 'https://maintmentor.ai';
const resend = new Resend(process.env.RESEND_API_KEY);

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Helpers ───────────────────────────────────────────────────────────────────

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60);
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Send invite email via Resend.
 */
async function sendInviteEmail({ toEmail, inviterName, orgName, inviteLink }) {
  try {
    await resend.emails.send({
      from: 'MaintMentor <support@maintmentor.ai>',
      to: toEmail,
      subject: `${inviterName} invited you to join ${orgName} on MaintMentor`,
      html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.08);overflow:hidden">
    <div style="background:#1e293b;padding:28px 32px;text-align:center">
      <img src="https://maintmentor.ai/icons/maintmentor-logo.png" alt="MaintMentor" style="height:48px;width:48px;object-fit:contain;border-radius:8px" />
      <h1 style="color:#f59e0b;font-size:22px;margin:12px 0 0;font-weight:700">MaintMentor</h1>
    </div>
    <div style="padding:32px">
      <h2 style="color:#1e293b;font-size:20px;margin:0 0 12px">You're invited! 🎉</h2>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 8px">
        <strong>${inviterName}</strong> has invited you to join <strong>${orgName}</strong> on MaintMentor — the AI-powered maintenance knowledge platform.
      </p>
      <p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 28px">
        Click the button below to set up your account. No credit card required — your team subscription covers your access.
      </p>
      <div style="text-align:center;margin:0 0 28px">
        <a href="${inviteLink}" style="display:inline-block;background:#f59e0b;color:#1e293b;text-decoration:none;font-weight:700;font-size:15px;padding:14px 32px;border-radius:8px">Join the Team →</a>
      </div>
      <p style="color:#94a3b8;font-size:12px;text-align:center;margin:0">
        This invite expires in 7 days. If you didn't expect this email, you can ignore it.
      </p>
    </div>
  </div>
</body>
</html>`,
    });
    console.log(`[team-manager] Invite email sent to ${toEmail}`);
  } catch (err) {
    // Non-fatal — link still works
    console.error(`[team-manager] Failed to send invite email to ${toEmail}:`, err.message);
  }
}

/**
 * Extract user ID from Authorization header (Bearer token → Supabase verify).
 * For Phase 1 MVP, we trust the userId in the request body when auth header is missing.
 */
async function getUserFromRequest(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return null;
    return user;
  }
  // Fallback: trust userId in body/query (for MVP; tighten in production)
  const userId = req.body?.userId || req.query?.userId;
  if (userId) return { id: userId };
  return null;
}

/**
 * Check if user is admin of a given org.
 */
async function isOrgAdmin(userId, orgId) {
  const { data } = await supabase
    .from('organization_members')
    .select('role')
    .eq('user_id', userId)
    .eq('org_id', orgId)
    .eq('status', 'active')
    .eq('role', 'admin')
    .maybeSingle();
  return !!data;
}

// ─── Route Registration ────────────────────────────────────────────────────────

function registerTeamRoutes(app) {

  // ─── CREATE ORG ────────────────────────────────────────────────────────────
  app.post('/api/team/create-org', async (req, res) => {
    try {
      const user = await getUserFromRequest(req);
      if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' });

      const { name, billingEmail, phone } = req.body;
      if (!name) return res.status(400).json({ success: false, error: 'Organization name is required' });

      const email = billingEmail || req.body.email;
      if (!email) return res.status(400).json({ success: false, error: 'Billing email is required' });

      // Check if user already belongs to an org
      const { data: existingMember } = await supabase
        .from('organization_members')
        .select('id, org_id')
        .eq('user_id', user.id)
        .maybeSingle();

      if (existingMember) {
        return res.status(409).json({ success: false, error: 'You are already a member of an organization' });
      }

      // Generate unique slug
      let slug = slugify(name);
      const { data: slugCheck } = await supabase
        .from('organizations')
        .select('id')
        .eq('slug', slug)
        .maybeSingle();
      if (slugCheck) {
        slug = `${slug}-${Date.now().toString(36)}`;
      }

      // Create org
      const { data: org, error: orgError } = await supabase
        .from('organizations')
        .insert({
          name,
          slug,
          billing_email: email,
          phone: phone || null,
          plan_type: 'team',
          subscription_status: 'trialing',
          seat_count: 1,
          trial_ends_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          created_by: user.id,
        })
        .select()
        .single();

      if (orgError) {
        console.error('[team-manager] Create org error:', orgError);
        return res.status(500).json({ success: false, error: 'Failed to create organization' });
      }

      // Add creator as admin member
      const { error: memberError } = await supabase
        .from('organization_members')
        .insert({
          org_id: org.id,
          user_id: user.id,
          role: 'admin',
          status: 'active',
          invited_email: email,
          invited_by: user.id,
          joined_at: new Date().toISOString(),
        });

      if (memberError) {
        console.error('[team-manager] Add admin member error:', memberError);
        // Clean up org
        await supabase.from('organizations').delete().eq('id', org.id);
        return res.status(500).json({ success: false, error: 'Failed to set up organization membership' });
      }

      // Update profile with org info
      await supabase
        .from('profiles')
        .update({ org_id: org.id, org_role: 'admin' })
        .eq('id', user.id);

      console.log(`[team-manager] Org created: ${org.name} (${org.id}) by user ${user.id}`);
      res.json({ success: true, organization: org });

    } catch (err) {
      console.error('[team-manager] create-org error:', err.message);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ─── INVITE MEMBER ─────────────────────────────────────────────────────────
  app.post('/api/team/invite-member', async (req, res) => {
    try {
      const user = await getUserFromRequest(req);
      if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' });

      const { orgId, email, phone } = req.body;
      if (!orgId || !email) {
        return res.status(400).json({ success: false, error: 'orgId and email are required' });
      }

      // Verify admin
      if (!(await isOrgAdmin(user.id, orgId))) {
        return res.status(403).json({ success: false, error: 'Only org admins can invite members' });
      }

      // Check if email already invited to this org
      const { data: existingInvite } = await supabase
        .from('organization_members')
        .select('id, status')
        .eq('org_id', orgId)
        .eq('invited_email', email.toLowerCase())
        .maybeSingle();

      if (existingInvite) {
        if (existingInvite.status === 'active') {
          return res.status(409).json({ success: false, error: 'This person is already a member' });
        }
        if (existingInvite.status === 'invited') {
          return res.status(409).json({ success: false, error: 'This person has already been invited. You can resend the invite.' });
        }
        // status === 'disabled' — previously removed, re-invite by reactivating
        if (existingInvite.status === 'disabled') {
          const now = new Date().toISOString();
          await supabase
            .from('organization_members')
            .update({ status: 'invited', user_id: null, invited_by: user.id, joined_at: null, disabled_at: null, updated_at: now })
            .eq('id', existingInvite.id);
          // Fall through using existingInvite.id as member
          existingInvite.status = 'invited'; // mark so we use it below
        }
      }

      // Check if the email user already belongs to another org
      const { data: existingUser } = await supabase
        .from('profiles')
        .select('id, org_id')
        .eq('email', email.toLowerCase())
        .maybeSingle();

      if (existingUser?.org_id && existingUser.org_id !== orgId) {
        return res.status(409).json({ success: false, error: 'This person is already a member of another organization' });
      }

      // Reuse reactivated disabled record, or create a new one
      let member;
      if (existingInvite?.status === 'invited') {
        member = { id: existingInvite.id };
      } else {
        const { data: newMember, error: memberError } = await supabase
          .from('organization_members')
          .insert({
            org_id: orgId,
            role: 'member',
            status: 'invited',
            invited_email: email.toLowerCase(),
            invited_phone: phone || null,
            invited_by: user.id,
          })
          .select()
          .single();

        if (memberError) {
          console.error('[team-manager] Invite member error:', memberError);
          return res.status(500).json({ success: false, error: 'Failed to create invite' });
        }
        member = newMember;
      }

      // Create invite token
      const token = generateToken();
      const { data: invite, error: inviteError } = await supabase
        .from('organization_invites')
        .insert({
          org_id: orgId,
          member_id: member.id,
          token,
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        })
        .select()
        .single();

      if (inviteError) {
        console.error('[team-manager] Create invite token error:', inviteError);
        // Clean up member
        await supabase.from('organization_members').delete().eq('id', member.id);
        return res.status(500).json({ success: false, error: 'Failed to create invite link' });
      }

      // Update seat count
      try {
        await supabase.rpc('increment_seat_count', { org_uuid: orgId });
      } catch (e) {
        // RPC doesn't exist yet — handled by manual increment below
      }

      // Increment seat count directly
      const { data: orgData } = await supabase
        .from('organizations')
        .select('seat_count')
        .eq('id', orgId)
        .single();
      
      if (orgData) {
        await supabase
          .from('organizations')
          .update({ seat_count: (orgData.seat_count || 0) + 1, updated_at: new Date().toISOString() })
          .eq('id', orgId);
      }

      const inviteLink = `${APP_URL}/invite/${token}`;
      console.log(`[team-manager] Invite created for ${email} → ${inviteLink}`);

      // Send invite email (non-blocking)
      const { data: inviterProfile } = await supabase
        .from('profiles')
        .select('full_name, email')
        .eq('id', user.id)
        .maybeSingle();
      const { data: orgForEmail } = await supabase
        .from('organizations')
        .select('name')
        .eq('id', orgId)
        .single();
      sendInviteEmail({
        toEmail: email,
        inviterName: inviterProfile?.full_name || inviterProfile?.email || 'Your manager',
        orgName: orgForEmail?.name || 'your team',
        inviteLink,
      });

      res.json({
        success: true,
        invite: {
          id: invite.id,
          memberId: member.id,
          token,
          inviteLink,
          expiresAt: invite.expires_at,
        },
      });

    } catch (err) {
      console.error('[team-manager] invite-member error:', err.message);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ─── GET INVITE INFO (public — for invite accept page) ────────────────────
  app.get('/api/team/invite/:token', async (req, res) => {
    try {
      const { token } = req.params;
      if (!token) return res.status(400).json({ success: false, error: 'Token is required' });

      const { data: invite, error } = await supabase
        .from('organization_invites')
        .select(`
          id, token, expires_at, accepted_at,
          org_id,
          member_id
        `)
        .eq('token', token)
        .maybeSingle();

      if (!invite || error) {
        return res.status(404).json({ success: false, error: 'Invite not found or invalid' });
      }

      if (invite.accepted_at) {
        return res.status(410).json({ success: false, error: 'This invite has already been accepted' });
      }

      if (new Date(invite.expires_at) < new Date()) {
        return res.status(410).json({ success: false, error: 'This invite has expired. Ask your manager to resend it.' });
      }

      // Get org info
      const { data: org } = await supabase
        .from('organizations')
        .select('id, name, slug')
        .eq('id', invite.org_id)
        .single();

      // Get member info (invited_email)
      const { data: member } = await supabase
        .from('organization_members')
        .select('invited_email, invited_by')
        .eq('id', invite.member_id)
        .single();

      // Get inviter name
      let inviterName = 'Your manager';
      if (member?.invited_by) {
        const { data: inviter } = await supabase
          .from('profiles')
          .select('full_name, email')
          .eq('id', member.invited_by)
          .single();
        if (inviter) {
          inviterName = inviter.full_name || inviter.email;
        }
      }

      res.json({
        success: true,
        invite: {
          token: invite.token,
          orgName: org?.name || 'Unknown Organization',
          orgId: org?.id,
          invitedEmail: member?.invited_email || '',
          inviterName,
          expiresAt: invite.expires_at,
        },
      });

    } catch (err) {
      console.error('[team-manager] get invite error:', err.message);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ─── ACCEPT INVITE ─────────────────────────────────────────────────────────
  app.post('/api/team/accept-invite', async (req, res) => {
    try {
      const { token, userId } = req.body;
      if (!token || !userId) {
        return res.status(400).json({ success: false, error: 'token and userId are required' });
      }

      // Get invite
      const { data: invite } = await supabase
        .from('organization_invites')
        .select('id, org_id, member_id, token, expires_at, accepted_at')
        .eq('token', token)
        .maybeSingle();

      if (!invite) {
        return res.status(404).json({ success: false, error: 'Invite not found' });
      }
      if (invite.accepted_at) {
        return res.status(410).json({ success: false, error: 'This invite has already been accepted' });
      }
      if (new Date(invite.expires_at) < new Date()) {
        return res.status(410).json({ success: false, error: 'This invite has expired' });
      }

      // Check if user already in an org
      const { data: existingMembership } = await supabase
        .from('organization_members')
        .select('id, org_id')
        .eq('user_id', userId)
        .eq('status', 'active')
        .maybeSingle();

      if (existingMembership) {
        return res.status(409).json({ success: false, error: 'You are already a member of an organization' });
      }

      // Update member record
      const now = new Date().toISOString();
      const { error: memberError } = await supabase
        .from('organization_members')
        .update({
          user_id: userId,
          status: 'active',
          joined_at: now,
          updated_at: now,
        })
        .eq('id', invite.member_id);

      if (memberError) {
        console.error('[team-manager] Accept invite member update error:', memberError);
        return res.status(500).json({ success: false, error: 'Failed to accept invite' });
      }

      // Mark invite as accepted
      await supabase
        .from('organization_invites')
        .update({ accepted_at: now })
        .eq('id', invite.id);

      // Update user profile with org info
      await supabase
        .from('profiles')
        .update({ org_id: invite.org_id, org_role: 'member' })
        .eq('id', userId);

      console.log(`[team-manager] Invite accepted: user ${userId} joined org ${invite.org_id}`);

      res.json({ success: true, orgId: invite.org_id });

    } catch (err) {
      console.error('[team-manager] accept-invite error:', err.message);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ─── REMOVE MEMBER ─────────────────────────────────────────────────────────
  app.post('/api/team/remove-member', async (req, res) => {
    try {
      const user = await getUserFromRequest(req);
      if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' });

      const { orgId, memberId } = req.body;
      if (!orgId || !memberId) {
        return res.status(400).json({ success: false, error: 'orgId and memberId are required' });
      }

      // Verify admin
      if (!(await isOrgAdmin(user.id, orgId))) {
        return res.status(403).json({ success: false, error: 'Only org admins can remove members' });
      }

      // Get the member
      const { data: member } = await supabase
        .from('organization_members')
        .select('id, user_id, role')
        .eq('id', memberId)
        .eq('org_id', orgId)
        .single();

      if (!member) {
        return res.status(404).json({ success: false, error: 'Member not found' });
      }

      // Can't remove yourself if you're the only admin
      if (member.user_id === user.id) {
        const { data: admins } = await supabase
          .from('organization_members')
          .select('id')
          .eq('org_id', orgId)
          .eq('role', 'admin')
          .eq('status', 'active');
        
        if (!admins || admins.length <= 1) {
          return res.status(400).json({ success: false, error: 'Cannot remove the last admin. Transfer admin role first.' });
        }
      }

      // Update member status to disabled
      const now = new Date().toISOString();
      await supabase
        .from('organization_members')
        .update({ status: 'disabled', disabled_at: now, updated_at: now })
        .eq('id', memberId);

      // Clear user's profile org fields
      if (member.user_id) {
        await supabase
          .from('profiles')
          .update({ org_id: null, org_role: null })
          .eq('id', member.user_id);
      }

      // Decrement seat count
      const { data: orgData } = await supabase
        .from('organizations')
        .select('seat_count')
        .eq('id', orgId)
        .single();

      if (orgData) {
        await supabase
          .from('organizations')
          .update({
            seat_count: Math.max(0, (orgData.seat_count || 1) - 1),
            updated_at: now,
          })
          .eq('id', orgId);
      }

      console.log(`[team-manager] Member ${memberId} removed from org ${orgId} by ${user.id}`);
      res.json({ success: true });

    } catch (err) {
      console.error('[team-manager] remove-member error:', err.message);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ─── GET ORGANIZATION ──────────────────────────────────────────────────────
  app.get('/api/team/org', async (req, res) => {
    try {
      const user = await getUserFromRequest(req);
      if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' });

      // Get user's org from profile
      const { data: profile } = await supabase
        .from('profiles')
        .select('org_id, org_role')
        .eq('id', user.id)
        .single();

      if (!profile?.org_id) {
        return res.json({ success: true, organization: null });
      }

      const { data: org } = await supabase
        .from('organizations')
        .select('*')
        .eq('id', profile.org_id)
        .single();

      res.json({
        success: true,
        organization: org,
        role: profile.org_role,
      });

    } catch (err) {
      console.error('[team-manager] get-org error:', err.message);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ─── GET MEMBERS ───────────────────────────────────────────────────────────
  app.get('/api/team/members', async (req, res) => {
    try {
      const user = await getUserFromRequest(req);
      if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' });

      const { orgId } = req.query;
      if (!orgId) return res.status(400).json({ success: false, error: 'orgId is required' });

      // Verify user belongs to this org
      const { data: membership } = await supabase
        .from('organization_members')
        .select('role')
        .eq('user_id', user.id)
        .eq('org_id', orgId)
        .eq('status', 'active')
        .maybeSingle();

      if (!membership) {
        return res.status(403).json({ success: false, error: 'You are not a member of this organization' });
      }

      // Get all members (not disabled)
      const { data: members, error } = await supabase
        .from('organization_members')
        .select('id, user_id, role, status, invited_email, invited_phone, invited_at, joined_at')
        .eq('org_id', orgId)
        .in('status', ['active', 'invited'])
        .order('created_at', { ascending: true });

      if (error) {
        console.error('[team-manager] get-members error:', error);
        return res.status(500).json({ success: false, error: 'Failed to fetch members' });
      }

      // Enrich with profile data for active members
      const enrichedMembers = await Promise.all(
        (members || []).map(async (m) => {
          if (m.user_id) {
            const { data: profile } = await supabase
              .from('profiles')
              .select('full_name, email')
              .eq('id', m.user_id)
              .maybeSingle();
            return {
              ...m,
              name: profile?.full_name || null,
              email: profile?.email || m.invited_email,
            };
          }
          return {
            ...m,
            name: null,
            email: m.invited_email,
          };
        })
      );

      res.json({ success: true, members: enrichedMembers });

    } catch (err) {
      console.error('[team-manager] get-members error:', err.message);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ─── RESEND INVITE ──────────────────────────────────────────────────────────
  app.post('/api/team/resend-invite', async (req, res) => {
    try {
      const user = await getUserFromRequest(req);
      if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' });

      const { orgId, memberId } = req.body;
      if (!orgId || !memberId) {
        return res.status(400).json({ success: false, error: 'orgId and memberId are required' });
      }

      if (!(await isOrgAdmin(user.id, orgId))) {
        return res.status(403).json({ success: false, error: 'Only org admins can resend invites' });
      }

      // Get member
      const { data: member } = await supabase
        .from('organization_members')
        .select('id, invited_email, status, invited_by')
        .eq('id', memberId)
        .eq('org_id', orgId)
        .maybeSingle();

      if (!member) return res.status(404).json({ success: false, error: 'Member not found' });
      if (member.status !== 'invited') {
        return res.status(400).json({ success: false, error: 'Member has already accepted the invite' });
      }

      // Expire old tokens and create a fresh one
      await supabase
        .from('organization_invites')
        .update({ accepted_at: new Date().toISOString() }) // mark as consumed so old link stops working
        .eq('member_id', memberId)
        .is('accepted_at', null);

      const token = generateToken();
      await supabase.from('organization_invites').insert({
        org_id: orgId,
        member_id: memberId,
        token,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      });

      // Update member invited_at
      await supabase
        .from('organization_members')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', memberId);

      const inviteLink = `${APP_URL}/invite/${token}`;

      // Get inviter + org info and send email
      const { data: inviterProfile } = await supabase
        .from('profiles').select('full_name, email').eq('id', user.id).maybeSingle();
      const { data: org } = await supabase
        .from('organizations').select('name').eq('id', orgId).single();

      sendInviteEmail({
        toEmail: member.invited_email,
        inviterName: inviterProfile?.full_name || inviterProfile?.email || 'Your manager',
        orgName: org?.name || 'your team',
        inviteLink,
      });

      console.log(`[team-manager] Invite resent to ${member.invited_email}`);
      res.json({ success: true, inviteLink });

    } catch (err) {
      console.error('[team-manager] resend-invite error:', err.message);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ─── GET INVITE LINK (for existing invited member) ─────────────────────────
  app.get('/api/team/invite-link/:memberId', async (req, res) => {
    try {
      const user = await getUserFromRequest(req);
      if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' });

      const { memberId } = req.params;
      const orgId = req.query.orgId;
      if (!orgId) return res.status(400).json({ success: false, error: 'orgId is required' });

      if (!(await isOrgAdmin(user.id, orgId))) {
        return res.status(403).json({ success: false, error: 'Only org admins can view invite links' });
      }

      // Get the latest active token for this member
      const { data: invite } = await supabase
        .from('organization_invites')
        .select('token, expires_at')
        .eq('member_id', memberId)
        .is('accepted_at', null)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!invite) {
        return res.status(404).json({ success: false, error: 'No active invite found. Use resend to create a new one.' });
      }

      res.json({ success: true, inviteLink: `${APP_URL}/invite/${invite.token}`, expiresAt: invite.expires_at });

    } catch (err) {
      console.error('[team-manager] get-invite-link error:', err.message);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  console.log('   Team Manager routes: ✅ Registered');
}

module.exports = { registerTeamRoutes };
