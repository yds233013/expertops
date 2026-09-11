/**
 * Demo helper: invite the best unengaged seeded expert to an open project and
 * print the resulting portal link, so the expert portal can be opened in a
 * browser without digging through the outbox.
 *
 * Development only. Run with `npx tsx scripts/demo-invite.ts`.
 */
import 'dotenv/config';
import { prisma } from '@/lib/db';
import { createInvitation, sendInvitation } from '@/server/services/invitations';
import { SYSTEM_ACTOR, operatorActor } from '@/server/services/activity';

async function main() {
  const user = await prisma.user.findFirstOrThrow({ where: { role: 'OPERATOR' } });
  const project = await prisma.project.findFirstOrThrow({
    where: { status: 'MATCHING' },
    include: { requirements: { include: { skill: true } } },
  });
  const requiredSlugs = project.requirements.filter((r) => r.required).map((r) => r.skill.slug);
  const expert = await prisma.expert.findFirstOrThrow({
    where: {
      status: 'PROSPECT',
      invitations: { none: {} },
      AND: requiredSlugs.map((slug) => ({ skills: { some: { skill: { slug } } } })),
    },
  });
  const invitation = await createInvitation(prisma, operatorActor(user), {
    projectId: project.id,
    expertId: expert.id,
    message: 'Browser demo invitation.',
  });
  const sent = await sendInvitation(prisma, SYSTEM_ACTOR, invitation.id);
  console.log('PORTAL_URL=' + sent!.portalUrl);
  console.log('EXPERT=' + expert.fullName);
  await prisma.$disconnect();
}
main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  await prisma.$disconnect().catch(() => undefined);
  process.exitCode = 1;
});
