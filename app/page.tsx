import { redirect } from 'next/navigation'

// Root redirecter til /captures - det er den primære daglige flade.
export default function Home() {
  redirect('/captures')
}
