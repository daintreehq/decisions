import { Link } from '../app/router.js';

/** Plain statement of every recipient, and the only place "end-to-end encrypted" is claimed. */
export function PrivacyPage() {
  return (
    <div className="page">
      <h1>Who sees what</h1>
      <p>
        Everything below is true for a normal deployment. Nothing here is sent to Daintree or anyone
        but you and the services you choose.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Who</th>
              <th scope="col">What they can see</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Your phone and your computer</th>
              <td>
                Everything: questions, context, screenshots and your answers, decrypted. Only these
                hold the keys.
              </td>
            </tr>
            <tr>
              <th scope="row">Your relay (your Cloudflare account)</th>
              <td>
                <strong>Encrypted</strong> questions, answers and images, plus routing information:
                when things happened, how big they are, which requirement level and expiry each
                question has, and your device names. It cannot read the content.
              </td>
            </tr>
            <tr>
              <th scope="row">Push services (Apple, Google, Mozilla)</th>
              <td>
                That a notification was sent to this phone, and a question id. Never the question,
                project or any text from an agent. The words on your lock screen are fixed in this
                app.
              </td>
            </tr>
            <tr>
              <th scope="row">Dictation providers (only if you turn dictation on)</th>
              <td>
                The audio you dictate and the transcript, passed through your relay. This part is{' '}
                <strong>not</strong> end-to-end encrypted. It is off until you opt in, and you can
                type instead.
              </td>
            </tr>
            <tr>
              <th scope="row">Daintree (the project)</th>
              <td>Nothing. There is no Daintree server in this system.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <h2>Limits worth knowing</h2>
      <ul className="plain">
        <li>
          If the code your relay serves were replaced by a malicious version, a web app cannot
          protect you from it. You own your deployment, so keep your Cloudflare account secure.
        </li>
        <li>
          Revoking a phone stops it receiving anything new. It cannot erase what it already saved.
        </li>
        <li>
          If every device that holds your keys is lost and you have no recovery kit, the encrypted
          history cannot be recovered.
        </li>
      </ul>
      <p>
        <Link to="/settings" className="btn">
          Back to settings
        </Link>
      </p>
    </div>
  );
}
