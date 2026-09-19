// A deliberately fixed pool keeps names stable across releases and machines.
// The session id chooses one entry; the workspace folder supplies the surname.
const FIRST_NAMES = `
Ada Aisha Albert Alec Alex Alice Alina Alison Alma Amara Amelia Amir Ana Anika Anita Anna Anne Annie Anton April Aria Ariel Arlo Arthur Arya Ashley Aspen Athena Audrey August Ava Avery Bailey Barbara Beatrice Beckett Bella Ben Benjamin Bennett Bernard Beth Bianca Blake Blair Bobby Bonnie Bradley Brandon Brendan Brianna Bridget Brigitte Brock Brooke Brooklyn Bruce Bruno Bryan Bryce Caleb Callum Calvin Cameron Camila Camille Carla Carlos Carmen Carol Caroline Carter Casey Cassandra Cassian Catalina Catherine Cecilia Celeste Celine Cesar Chad Charles Charlie Charlotte Chloe Chris Christian Christina Claire Clara Clarissa Claude Claudia Clayton Cleo Cody Colby Cole Colin Conor Connor Conrad Cora Coraline Corey Corinne Craig Crystal Curtis Daisy Dakota Dale Damian Damien Damon Dan Dana Daniel Daniela Daphne Daria David Dawn Dean Delia Derek Desiree Diana Diego Dillon Dominic Don Donald Dora Dorothy Douglas Drew Dylan Eden Edith Eduardo Edward Edwin Eileen Elaine Eleanor Elena Eli Elias Elijah Elisa Elise Eliza Elizabeth Ella Ellen Ellie Elliot Elliott Elsa Elsie Emery Emilia Emily Emma Emmanuel Eric Erica Erin Esme Ethan Eva Evan Evelyn Everett Faith Felix Fiona Finn Flora Florence Floyd Frances Francesca Francis Frank Frankie Frederick Freya Gabriel Gabriela Gail Gavin Gemma Genevieve George Georgia Gerald Gia Gideon Gillian Gina Giselle Gloria Grace Graham Grant Greta Griffin Gwen Hailey Halle Hannah Harper Harrison Harvey Hazel Hector Heidi Helen Henry Holly Hope Hudson Hugo Ian Ibrahim Ida Imogen Ingrid Irene Iris Isaac Isabel Isabelle Isla Ivan Ivy Jack Jackie Jacob Jade Jake James Jamie Janae Jane Janet Jasmine Jason Jasper Javier Jay Jayden Jean Jenna Jennifer Jenny Jeremy Jessica Jill Joanna Jocelyn Joel Joey John Johnny Jonah Jonas Jordan Joseph Josephine Joshua Josie Joy Juan Julia Julian Julie June Justin Kai Kara Karen Karina Karl Kate Katherine Kathleen Kathryn Katie Kayla Keira Keith Kelly Kelsey Kendall Kenneth Kevin Kiara Kieran Kim Kimberly Kingston Kira Kirsten Kurt Kyle Kylie Lana Lara Laura Lauren Layla Leah Lee Lena Leo Leon Leonard Leslie Levi Liam Lila Lily Linda Logan Lola Lorelei Lorenzo Louisa Lucas Lucy Luis Luna Lydia Lyla Lynn Mabel Mackenzie Madeline Madison Mae Malcolm Malik Mara Marcus Margaret Maria Mariana Marie Marina Mark Marley Martha Martin Mason Mateo Matilda Matt Matthew Max Maya Megan Melody Melissa Mia Michael Michaela Mila Miles Milo Mina Miranda Mira Molly Monica Morgan Nadia Nadine Naomi Natalia Natalie Nathan Nathaniel Neil Nell Nelson Nicholas Nicole Nina Noah Noelle Nora Nolan Norah Octavia Odin Oliver Olivia Omar Opal Oscar Owen Paige Parker Patricia Patrick Paul Paula Pauline Payton Pearl Penelope Penny Percy Peter Petra Philip Phoebe Piper Poppy Porter Preston Quinn Rachel Rafael Raquel Ray Rebecca Reed Reese Regina Reid Remy Renee Reyna Rhea Riley Rita River Robert Robin Roberto Rose Rowan Roxanne Ruby Russell Ruth Ryan Sabrina Sadie Sage Sally Samantha Samuel Sandra Sara Sarah Sasha Saul Savannah Scarlett Scott Sean Sebastian Selena Serena Seth Shannon Sharon Shaun Shawn Sheila Shelby Sidney Sierra Simon Simone Sofia Sonia Sophia Spencer Stella Stephanie Stephen Sterling Steve Steven Summer Susan Susannah Sydney Sylvia Talia Tamara Tania Tara Taylor Teresa Theo Theodore Theresa Thomas Tiana Tiara Tobias Toby Todd Tom Tommy Tony Tori Tristan Troy Tyler Uma Una Valentina Valerie Vanessa Vera Veronica Victoria Vincent Viola Violet Virginia Vivian Wade Walker Walter Warren Wesley Weston Whitney William Willow Willa Winnie Wyatt Xander Xavier Yara Yasmine Yasmin Yvette Zachary Zane Zara Zelda Zoe Zoey Zora`
  .trim()
  .split(/\s+/);

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function normalizeFolderSurname(folderName?: string): string {
  const letters = (folderName ?? '').replace(/[^A-Za-z]/g, '');
  if (!letters) return 'Workspace';
  return letters[0].toUpperCase() + letters.slice(1).toLowerCase();
}

export function getAgentDisplayName(sessionId: string, folderName?: string): string {
  const firstName = FIRST_NAMES[hashString(sessionId) % FIRST_NAMES.length];
  return `${firstName} ${normalizeFolderSurname(folderName)}`;
}

export const AGENT_FIRST_NAME_COUNT = FIRST_NAMES.length;
