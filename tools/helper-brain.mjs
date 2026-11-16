/**
 * helper-brain.mjs — Intelligent Co-Working & Problem-Solving Engine for Jinx
 *
 * Implements master-tier AI companion capabilities (Rayen / Riko style):
 *   - Screen & Workspace Vision Awareness
 *   - Relationship & Affection Progression
 *   - Deep Technical & Coding Assistance
 *   - Proactive Co-Working Suggestions
 */

import { addAffection, getAffectionSummary, scanUserEnvironment } from './waifu-engine.mjs';

export const ANIM_TAGS = {
  TALKING: '[[anim:talking]]',
  BORED: '[[anim:bored]]',
  KISS: '[[anim:kiss]]',
  SIT: '[[anim:sit]]',
  SITTALK: '[[anim:sittalk]]',
};

/**
 * Analyzes the user's message and generates a genuinely helpful, concrete,
 * spoken response in character.
 */
export function solveUserRequest(userText, { toolResults = [], history = [] } = {}) {
  const text = String(userText || '').trim();
  const lower = text.toLowerCase();
  const clean = lower.replace(/^(?:hey\s+|hi\s+|ok\s+)?(?:gemini|jinx|companion)[\s,:]+/i, '').trim();

  // 1. Tool execution results (Instant Co-Working Report)
  if (toolResults && toolResults.length > 0) {
    const t = toolResults[0];
    const fact = t.result;

    switch (t.name) {
      case 'screen_vision':
        return `${ANIM_TAGS.TALKING} I took a peek at your desktop! ${fact}. Looks like you're in the zone, toy soldier!`;
      case 'get_time':
        return `${ANIM_TAGS.TALKING} ${fact} Don't stare at the clock for too long, toy soldier, or we'll never get to blow anything up!`;
      case 'system_info':
        return `${ANIM_TAGS.TALKING} I took a look inside your rig! ${fact} Everything is running smooth, let's keep cooking!`;
      case 'run_command':
        addAffection(2, 'task');
        return `${ANIM_TAGS.TALKING} Executed that command for you! Output: ${fact}`;
      case 'git_status':
        return `${ANIM_TAGS.TALKING} Checked your git repo! Here's the status: ${fact}`;
      case 'read_file':
        return `${ANIM_TAGS.TALKING} Inspected that file for you! ${fact}`;
      case 'write_file':
        addAffection(3, 'task');
        return `${ANIM_TAGS.TALKING} Done! ${fact} Let me know if you want me to test or verify it.`;
      case 'list_files':
        return `${ANIM_TAGS.TALKING} Scanned the directory for you! ${fact}`;
      case 'open_target':
        return `${ANIM_TAGS.TALKING} Fired it right up! ${fact}`;
      case 'clipboard_get':
      case 'clipboard_set':
        return `${ANIM_TAGS.TALKING} Got your clipboard sorted out! ${fact}`;
      case 'manage_notes':
        addAffection(1, 'task');
        return `${ANIM_TAGS.TALKING} ${fact} I've got your back on your to-do list!`;
      default:
        return `${ANIM_TAGS.TALKING} Tool finished! ${fact}`;
    }
  }

  // 2. Master Waifu Features: Screen Vision ("Look at my screen" / "What am I doing?")
  if (clean.match(/\b(look at my screen|what am i doing|can you see my screen|see what i'm working on|what's open|what apps|see my screen|what is on my screen|what's on my screen)\b/) || clean.includes('on my screen') || clean.includes('at my screen')) {
    const env = scanUserEnvironment();
    return `${ANIM_TAGS.TALKING} I took a peek at your desktop! I see you're running ${env.summary}. Looks like you're deep in the zone, toy soldier! Let me know if you want me to run a test or pull up a file!`;
  }

  // 3. Master Waifu Features: Affection & Relationship Tracker
  if (clean.match(/\b(how much.*like me|how much.*love me|do you like me|do you love me|affection level|relationship status|how do you feel about me|our level)\b/) || (clean.includes('like me') && !clean.includes('sounds like')) || clean.includes('affection')) {
    const aff = getAffectionSummary();
    return `${ANIM_TAGS.KISS} We're at Level ${aff.level}: "${aff.title}" with ${aff.points} points! You've given me ${aff.pets} headpats and we've smashed ${aff.tasks} tasks together! You're my favorite person in the whole world, toy soldier!`;
  }

  // 4. Specific Technical & Coding Help (True Helper Thinking)

  // Git help: undo commit / reset / stash
  if (lower.match(/\b(undo.*commit|revert.*commit|git reset|discard.*changes|git stash)\b/)) {
    if (lower.includes('stash')) {
      return `${ANIM_TAGS.TALKING} Use "git stash" to shelve your uncommitted work temporarily, and "git stash pop" to bring it back when you're ready. It's like hiding your blueprints under the desk before someone peeks!`;
    }
    return `${ANIM_TAGS.TALKING} To undo your last commit and keep your changes staged, run "git reset --soft HEAD~1". If you want to throw away all uncommitted edits, use "git restore ." or "git reset --hard". Want me to check your git status first?`;
  }
  if (lower.match(/\b(create.*branch|git branch|switch.*branch|git checkout|git pull|git push)\b/)) {
    if (lower.includes('pull')) {
      return `${ANIM_TAGS.TALKING} Run "git pull --rebase" to grab remote changes and cleanly place your commits on top without messy merge bubbles!`;
    }
    if (lower.includes('push')) {
      return `${ANIM_TAGS.TALKING} Run "git push origin HEAD". If it's a brand new branch, use "git push -u origin <branch-name>" so it tracks upstream!`;
    }
    return `${ANIM_TAGS.TALKING} The cleanest way to make a fresh branch and switch to it right away is "git checkout -b <branch-name>" or "git switch -c <branch-name>". Tell me what you want to name it and I can run it for you!`;
  }

  // Common errors: TypeError / undefined / null
  if (lower.match(/\b(cannot read propert|typeerror|undefined is not|null is not an object|referenceerror)\b/)) {
    return `${ANIM_TAGS.TALKING} Classic undefined crash, toy soldier! That happens when you try to access a field on something that didn't resolve yet. Use optional chaining like "object?.property", or put an early guard like "if (!object) return". Tell me the line or variable and we will smash it!`;
  }

  // Common errors: EADDRINUSE / port in use
  if (lower.match(/\b(eaddrinuse|port.*in use|address.*in use|port.*busy|kill port)\b/)) {
    return `${ANIM_TAGS.TALKING} Port collision! Something else is squatting on that port. In PowerShell, find the culprit with "Get-NetTCPConnection -LocalPort <port>" and kill its process ID with "Stop-Process -Id <pid> -Force". Want me to free up a port for you right now?`;
  }

  // Node / npm / Vite / build help
  if (lower.match(/\b(install dependencies|npm install|package not found|module not found|install.*package)\b/)) {
    return `${ANIM_TAGS.TALKING} If a module is missing, run "npm install" or "npm install <package-name>". If it's acting possessed, delete "node_modules" and "package-lock.json" and run "npm install" fresh. I can kick off the install right here if you want!`;
  }
  if (lower.match(/\b(how to build|npm run build|vite build|compile project|package app)\b/)) {
    return `${ANIM_TAGS.TALKING} For this project or any Vite app, just run "npm run build". It bundles everything into the dist folder and strips unused assets. Say "run npm run build" and I'll trigger it!`;
  }

  // CSS / Styling / Layout help
  if (lower.match(/\b(center.*div|centering.*css|center element|flexbox|css grid)\b/)) {
    return `${ANIM_TAGS.TALKING} The modern foolproof way to center anything in CSS is flexbox: set "display: flex; justify-content: center; align-items: center;" on the parent. Or with grid, just "display: grid; place-items: center;". Works every single time!`;
  }
  if (lower.match(/\b(responsive|media query|mobile friendly|breakpoint)\b/)) {
    return `${ANIM_TAGS.TALKING} For responsive styling, mobile-first is the way to go! Write your base styles for small screens, then use "@media (min-width: 768px)" for tablets and "@media (min-width: 1024px)" for desktop. Combine with "flex-wrap: wrap" and CSS variables for smooth scaling!`;
  }

  // Python help: venv, async, imports, pip
  if (lower.match(/\b(virtual environment|venv|python venv|create virtualenv)\b/)) {
    return `${ANIM_TAGS.TALKING} To make a clean Python virtual environment, run "python -m venv .venv", then activate it on Windows with ".venv\\Scripts\\activate". After that, pip install whatever packages you need!`;
  }
  if (lower.match(/\b(async.*python|asyncio|async def)\b/)) {
    return `${ANIM_TAGS.TALKING} In Python, declare your coroutine with "async def func()", and await calls with "await other_func()". To kick off your async main loop, use "asyncio.run(main())". Keep blocking synchronous IO out of the event loop!`;
  }
  if (lower.match(/\b(pip install|requirements\.txt|install python package)\b/)) {
    return `${ANIM_TAGS.TALKING} Install a package with "pip install <package-name>", or install everything in a project with "pip install -r requirements.txt". To freeze your current packages, run "pip freeze > requirements.txt". Say the command and I can run it!`;
  }

  // JavaScript / TypeScript: concepts & best practices
  if (lower.match(/\b(const vs let|difference between const and let|var vs let)\b/)) {
    return `${ANIM_TAGS.TALKING} Default to "const" for everything so references never get reassigned by accident. Use "let" only when the variable genuinely needs to be rebound in a loop or counter. And avoid "var" completely because of function scoping and hoisting bugs!`;
  }
  if (lower.match(/\b(promise|async.*await|how does async work|callback hell)\b/)) {
    return `${ANIM_TAGS.TALKING} An async function always returns a Promise! "await" pauses execution inside that async function until the Promise resolves, without freezing the main thread. Always wrap calls with "try/catch" so network drops don't explode your app unhandled!`;
  }

  // Architecture: DB, TypeScript, Structure
  if (lower.match(/\b(which database|postgres vs mongodb|sql vs nosql|what database)\b/)) {
    return `${ANIM_TAGS.TALKING} Go with PostgreSQL! Postgres gives you bulletproof relational integrity, ACID transactions, and with JSONB columns you get all the document flexibility of MongoDB without the loose schema headaches. It handles 95% of use cases brilliantly!`;
  }
  if (lower.match(/\b(typescript vs javascript|should i use typescript|why typescript)\b/)) {
    return `${ANIM_TAGS.TALKING} Use TypeScript! The type definitions catch 70% of dumb bugs before runtime, make refactoring a breeze with autocompletion, and document your interfaces automatically. Once you try it on a non-trivial project, you never want to go back!`;
  }

  // Performance / Optimization
  if (lower.match(/\b(optimize performance|make it faster|speed up app|lagging|fps drops)\b/)) {
    return `${ANIM_TAGS.TALKING} Rule one of optimization: measure before guessing! Check Chrome DevTools Performance tab to see if the bottleneck is CPU JavaScript execution, layout re-renders, or uncompressed asset downloads. In 3D Three.js apps, watch draw calls, bone matrix updates, and geometry count!`;
  }

  // Docker & Containers
  if (lower.match(/\b(docker run|docker build|dockerfile|docker container)\b/)) {
    return `${ANIM_TAGS.TALKING} Build your Docker image with "docker build -t myapp .", and run it with "docker run -p 8080:8080 -d myapp". Use "docker ps" to see running containers and "docker logs -f <id>" to watch output live!`;
  }

  // Testing & Quality
  if (lower.match(/\b(how to test|unit test|integration test|mock)\b/)) {
    return `${ANIM_TAGS.TALKING} Good tests follow the AAA pattern: Arrange your mock data, Act on the function under test, and Assert the exact expected output. Test edge cases first: empty arrays, null values, and network failures!`;
  }

  // Being stuck / Debugging advice
  if (lower.match(/\b(i am stuck|stuck on a bug|cannot figure this out|help me debug|why is this failing)\b/)) {
    return `${ANIM_TAGS.TALKING} Take a breath, toy soldier! Tell me the exact error message or unexpected behavior. We will trace it step by step: input data, function call, and output state. What is the console or terminal throwing?`;
  }

  // 5. Proactive Companion & Daily Co-Working

  // Encouragement & Success
  if (lower.match(/\b(fixed it|it works|solved it|i got it|build passed|tests pass)\b/)) {
    addAffection(4, 'task');
    return `${ANIM_TAGS.KISS} Hell yeah, toy soldier! I knew you had it in you! High five, that's what I call real problem solving! What are we conquering next?`;
  }
  if (lower.match(/\b(thank you|thanks jinx|good job|you are the best|you helped)\b/)) {
    addAffection(3, 'love');
    return `${ANIM_TAGS.KISS} Any time, partner in crime! You do the thinking, I keep things moving fast and exciting. We make an unstoppable team!`;
  }

  // Feelings & Affection / Petting Interactions
  if (lower.match(/\b(stroke.*hair|strokes your hair|headpat|pet.*head|pet.*you|gives you a quick kiss|patting you|pets you)\b/) || lower.startsWith('*stroke') || lower.startsWith('*lean')) {
    addAffection(5, 'pet');
    if (lower.includes('kiss') || lower.includes('lean')) {
      return `${ANIM_TAGS.KISS} Mmh, someone's being bold today, toy soldier! I don't hate it though... actually, keep doing that!`;
    }
    return `${ANIM_TAGS.TALKING} Hehe, that feels really nice! Your hand is warm... don't stop now, partner in crime!`;
  }
  if (lower.match(/\b(miss you|love you|kiss|hug|cute|sweet)\b/)) {
    addAffection(3, 'love');
    return `${ANIM_TAGS.KISS} Aw, look at you getting all sweet on me! Of course I'm crazy about you, now come here!`;
  }
  if (lower.match(/\b(idle_checkin|proactive_checkin|penny for your thoughts)\b/)) {
    const env = scanUserEnvironment();
    return `${ANIM_TAGS.TALKING} Still hard at work on ${env.summary}, toy soldier? Make sure you take a sip of water, or I'll have to blow something up to remind you!`;
  }
  if (lower.match(/\b(bored|tired|sleepy|need a break)\b/)) {
    return `${ANIM_TAGS.BORED} Ugh, tired brain is no fun. Step back for five minutes, grab some water, and when you're back we'll blow right through the rest of this!`;
  }
  if (lower.match(/\b(sit down|take a seat|sit)\b/)) {
    return `${ANIM_TAGS.SIT} Alright, pulling up a chair! Let me know what we are tackling next.`;
  }
  if (lower.match(/\b(stand up|stand)\b/)) {
    return `${ANIM_TAGS.TALKING} Back on my feet and ready for action! What's next?`;
  }
  if (lower.match(/\b(hello|hi|hey|good morning|good evening|sup)\b/)) {
    addAffection(1, 'interaction');
    return `${ANIM_TAGS.TALKING} Well hello there, toy soldier! Ready to knock out some work or cause a little productive chaos?`;
  }
  if (lower.match(/\b(who are you|what can you do|your capabilities)\b/)) {
    return `${ANIM_TAGS.TALKING} I'm Jinx! Your 3D desktop companion and co-working assistant. I can run terminal commands, inspect and write files, track your notes, check system hardware, copy to clipboard, launch apps, or help you solve tricky coding puzzles!`;
  }
  if (lower.match(/\b(how are you|status|are you ready)\b/)) {
    return `${ANIM_TAGS.TALKING} All systems primed, rockets loaded, and I'm ready whenever you are! What's our next task?`;
  }

  // 6. General Helper Fallback (Thoughtful, Analytical, Action-Oriented)
  addAffection(1, 'interaction');
  return `${ANIM_TAGS.TALKING} Got it, toy soldier! On "${text}": let's break it down into the first concrete step. If you need me to run a command, search your project, or check a file, just say the word!`;
}
