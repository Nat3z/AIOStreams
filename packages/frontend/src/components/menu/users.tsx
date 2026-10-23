import { PageWrapper } from '../shared/page-wrapper';
import { SettingsCard } from '../shared/settings-card';
import { PageControls } from '../shared/page-controls';
import { ProfileList } from './profiles/profile-list';

export function UsersMenu() {
  return (
    <PageWrapper className="space-y-4 p-4 sm:p-8">
      <div className="flex items-center w-full">
        <div>
          <h2>Users</h2>
          <p className="text-[--muted]">
            Everyone who signs in to your server. Add someone, then send them a
            setup link to pick their own password and preferences.
          </p>
        </div>
        <div className="hidden lg:block lg:ml-auto">
          <PageControls />
        </div>
      </div>
      <SettingsCard>
        <ProfileList />
      </SettingsCard>
    </PageWrapper>
  );
}
