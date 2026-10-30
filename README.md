# Kettle & Stone waitlist shortlist

## How to run it

About 10 minutes the first time, 1 minute after that. No coding needed: you copy a few short lines and press Enter.

## Set it up (once per computer)

1. **Install Node.js.** Go to [nodejs.org](https://nodejs.org), download the version marked **LTS** and run the installer. Click Next until it finishes.
2. **Get the tool's folder.** On this page, click the green **Code** button, then **Download ZIP**. Right-click the downloaded file and choose **Extract All**. Put the folder somewhere easy, like the Desktop.
3. **Open a terminal in that folder.** Open the folder, right-click an empty spot inside it and choose **Open in Terminal**. A window with a blinking cursor opens. That's where you type.
4. **Install the tool's parts.** Type this and press Enter. Wait until the cursor comes back (1 to 2 minutes).

   ```
   npm install
   ```

## Start it (every time)

5. **Start the tool.** In the terminal, type this and press Enter. When it says **Ready**, it's running. Keep this window open while you use the tool.

   ```
   npm run dev
   ```

6. **Open it in the browser.** Open Chrome or Edge and go to `localhost:3000`.

## Use it (each time an opening comes up)

7. **Load the three files.** Click **Waitlist (admin)** at the top. Choose the waitlist file, the late openings file and the booking export. Set the run date, then press **Import and analyse**.

   To try it first, use the files in the `data/sample` folder with run date **Oct 21, 2026**.
8. **Find who to call.** Click **Search**. For every opening in the file: pick **All openings from a file** and press **Search all openings**. For one new opening: pick **One opening**, fill in the date, time, therapist and length, and press **Search waitlist**.

   You'll see up to 3 names in waitlist order, or "nobody" if no one fits.
9. **Call, then mark it.** Call the first name. If they say yes and you've booked them in Kneadly, press **Booked**, and they come off every other opening. No answer or no thanks? Call the next name. Pressed it by mistake? Press **Undo**.

## Stop it (when you're done)

10. **Close the tool.** Click in the terminal window, press **Ctrl + C**, then close the window.

## If something goes wrong

| What you see | What to do |
|---|---|
| "A file is refused" | The message names the missing column. Use the file exactly as it was exported. Don't edit it. |
| People show as "not read" | A new waitlist needs the Claude key to read the notes. Ask the builder to connect it. |
| The page shows an error | Stop it (step 10), delete the `.next` folder inside the tool's folder, then start it again (step 5). |

The tool only suggests names. It never contacts clients and never changes your files.
