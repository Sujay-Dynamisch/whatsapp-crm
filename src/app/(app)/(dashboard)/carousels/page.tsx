import { redirect } from 'next/navigation';

export default function CarouselsPage() {
  redirect('/settings?tab=templates');
}
