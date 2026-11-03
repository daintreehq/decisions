import { DataFlow, PrivacyLimits } from '../components/settings/DataFlow.js';
import { SettingsGroup } from '../components/settings/ui.js';
import { BackLink } from './Install.js';

/** Plain statement of every recipient, and the only place "end-to-end encrypted" is claimed. */
export function PrivacyPage() {
  return (
    <div className="page s-page s-standalone">
      <BackLink />
      <h1 className="s-title">Who sees what</h1>
      <p className="s-lead">
        True for a normal deployment. Nothing goes to Daintree or anyone except you and the services
        you choose.
      </p>
      <SettingsGroup>
        <DataFlow />
      </SettingsGroup>
      <SettingsGroup label="Limits worth knowing">
        <PrivacyLimits />
      </SettingsGroup>
    </div>
  );
}
