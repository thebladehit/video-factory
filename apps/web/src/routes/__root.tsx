import { createRootRoute, Outlet } from '@tanstack/react-router';
import { AppSidebar } from '@/components/AppSidebar';
import { UploadProvider } from '@/components/upload/UploadProvider';
import { JobFeedProvider } from '@/lib/job-feed';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/sonner';

export const Route = createRootRoute({
  component: () => (
    <JobFeedProvider>
      <UploadProvider>
        <SidebarProvider>
          <AppSidebar />
          <SidebarInset>
            <header className="flex h-12 items-center border-b px-3">
              <SidebarTrigger />
            </header>
            <main className="p-6">
              <Outlet />
            </main>
          </SidebarInset>
          <Toaster richColors />
        </SidebarProvider>
      </UploadProvider>
    </JobFeedProvider>
  ),
});
