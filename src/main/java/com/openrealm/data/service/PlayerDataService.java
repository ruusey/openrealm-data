package com.openrealm.data.service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Date;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.stream.Collectors;

import javax.servlet.http.HttpServletRequest;

import org.modelmapper.ModelMapper;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Service;

import com.openrealm.data.auth.PlayerIdentityFilter;
import com.openrealm.data.dto.auth.AccountDto;
import com.openrealm.data.dto.auth.AccountProvision;
import com.openrealm.data.dto.CharacterDto;
import com.openrealm.data.dto.CharacterStatsDto;
import com.openrealm.data.dto.LeaderboardEntryDto;
import com.openrealm.data.dto.ChestDto;
import com.openrealm.data.dto.EnchantmentDto;
import com.openrealm.data.dto.GameItemRefDto;
import com.openrealm.data.dto.PlayerAccountDto;
import com.openrealm.data.entity.EnchantmentEntity;
import com.openrealm.data.entity.CharacterEntity;
import com.openrealm.data.entity.CharacterStatsEntity;
import com.openrealm.data.entity.ChestEntity;
import com.openrealm.data.entity.GameItemRefEntity;
import com.openrealm.data.entity.PlayerAccountEntity;
import com.openrealm.data.entity.auth.AccountEntity;
import com.openrealm.data.repository.ChestRepository;
import com.openrealm.data.repository.GameItemRefRepository;
import com.openrealm.data.repository.PlayerAccountRepository;
import com.openrealm.data.repository.auth.AccountRepository;
import com.openrealm.game.contants.CharacterClass;
import com.openrealm.game.data.GameDataManager;
import com.openrealm.game.entity.item.GameItem;

import lombok.extern.slf4j.Slf4j;

@Service
@Slf4j
public class PlayerDataService {
    private final transient AccountRepository accountRepository;
    private final transient PlayerAccountRepository playerAccountRepository;
    private final transient ChestRepository playerChestRepository;
    private final transient GameItemRefRepository gameItemRefRepository;
    private final transient PlayerIdentityFilter authFilter;
    private final transient AccountService accountService;
    private final transient ModelMapper mapper;

    public PlayerDataService(@Autowired final AccountRepository accountRepository,
            @Autowired final PlayerAccountRepository playerAccountRepository,
            @Autowired final ChestRepository playerChestRepository,
            @Autowired final GameItemRefRepository gameItemRefRepository,
            @Autowired final PlayerIdentityFilter authFilter,
            @Autowired final AccountService accountService,
            @Autowired final ModelMapper mapper) {
        this.accountRepository = accountRepository;
        this.playerAccountRepository = playerAccountRepository;
        this.playerChestRepository = playerChestRepository;
        this.gameItemRefRepository = gameItemRefRepository;
        this.authFilter = authFilter;
        this.accountService = accountService;
        this.mapper = mapper;
    }

    @EventListener(ApplicationReadyEvent.class)
    @Order(2)
    public void seedAccounts() {
        try {

            if (this.playerAccountRepository.count() == 0L) {
                for (AccountEntity account : this.accountRepository.findAll()) {
                    this.createInitialAccount(account.getAccountGuid(), account.getEmail(), account.getAccountName(),
                            CharacterClass.WIZARD.classId);
                }
            }
        } catch (Exception e) {
            PlayerDataService.log.error("Failed to seed Player Account. Reason: {}", e);
        }
    }

    public CharacterDto saveCharacterStats(final HttpServletRequest request, final String characterUuid, final CharacterDto newData) throws Exception {
        final long start = Instant.now().toEpochMilli();
        PlayerAccountEntity ownerAccount = this.playerAccountRepository.findByCharactersCharacterUuid(characterUuid);
        if (!this.authFilter.accountGuidMatch(ownerAccount.getAccountUuid(), request)) {
            throw new Exception("Invalid token");
        }
        final CharacterEntity character = ownerAccount.findCharacterByUuid(characterUuid);
        if (character == null)
            throw new Exception("Character with UUID " + characterUuid + " was not found.");

        character.getStats().setHp(newData.getStats().getHp());
        character.getStats().setMp(newData.getStats().getMp());
        character.getStats().setDef(newData.getStats().getDef());
        character.getStats().setAtt(newData.getStats().getAtt());
        character.getStats().setSpd(newData.getStats().getSpd());
        character.getStats().setDex(newData.getStats().getDex());
        character.getStats().setWis(newData.getStats().getWis());
        character.getStats().setVit(newData.getStats().getVit());
        character.getStats().setXp(newData.getStats().getXp());

        character.removeItems();

        int mapped = 0, failed = 0;
        for (GameItemRefDto item : newData.getItems()) {
            if (item == null) {
                continue;
            }
            try {
                final GameItemRefEntity itemEntity = toItemEntity(item);
                character.addItem(itemEntity);
                mapped++;
            } catch (Exception e) {
                failed++;
                PlayerDataService.log.error(
                        "[saveCharacterStats] FAILED to map item itemId={} slot={} uuid={} (skipping). Reason: {}",
                        item.getItemId(), item.getSlotIdx(), item.getItemUuid(), e.getMessage(), e);
            }
        }
        PlayerDataService.log.debug("[saveCharacterStats] character {} mapped {} items ({} failed)",
                characterUuid, mapped, failed);

        ownerAccount = this.playerAccountRepository.save(ownerAccount);
        PlayerDataService.log.debug("Successfully saved character stats for character {} in {}ms",
                character.getCharacterUuid(), (Instant.now().toEpochMilli() - start));
        final CharacterDto out = this.mapper.map(character, CharacterDto.class);
        // Re-attach items explicitly so the response has stackCount + enchantments.
        if (character.getItems() != null) {
            final List<GameItemRefDto> rebuilt = new ArrayList<>(character.getItems().size());
            for (final GameItemRefEntity ie : character.getItems()) {
                final GameItemRefDto id = toItemDto(ie);
                if (id != null) rebuilt.add(id);
            }
            out.setItems(rebuilt);
        }
        return out;
    }
    
    public List<LeaderboardEntryDto> getTopCharacters(int count) {
        final List<LeaderboardEntryDto> results = new ArrayList<>();
        final List<PlayerAccountEntity> accounts = this.playerAccountRepository.findAll();

        // Flatten all characters with their account name, sort by XP descending
        final List<Map.Entry<String, CharacterEntity>> ranked = new ArrayList<>();
        for (PlayerAccountEntity acc : accounts) {
            if (acc.getCharacters() == null) continue;
            for (CharacterEntity ch : acc.getCharacters()) {
                if (ch.getDeleted() != null) continue; // exclude dead characters
                if (ch.getStats() == null || ch.getStats().getXp() == null) continue;
                ranked.add(Map.entry(acc.getAccountName() != null ? acc.getAccountName() : "Unknown", ch));
            }
        }
        ranked.sort((a, b) -> Long.compare(
                b.getValue().getStats().getXp(),
                a.getValue().getStats().getXp()));

        final int limit = Math.min(count, ranked.size());
        for (int i = 0; i < limit; i++) {
            final Map.Entry<String, CharacterEntity> entry = ranked.get(i);
            final CharacterEntity ch = entry.getValue();
            final CharacterStatsDto statsDto = this.mapper.map(ch.getStats(), CharacterStatsDto.class);
            final Integer classId = ch.getStats().getClassId() != null ? ch.getStats().getClassId() : ch.getCharacterClass();

            // Resolve level and class name from game data
            int level = 1;
            long fame = 0;
            String className = "Unknown";
            if (GameDataManager.EXPERIENCE_LVLS != null && statsDto.getXp() != null) {
                level = GameDataManager.EXPERIENCE_LVLS.getLevel(statsDto.getXp());
                fame = GameDataManager.EXPERIENCE_LVLS.getBaseFame(statsDto.getXp());
            }
            if (GameDataManager.CHARACTER_CLASSES != null && classId != null) {
                final com.openrealm.game.model.CharacterClassModel model = GameDataManager.CHARACTER_CLASSES.get(classId);
                if (model != null) className = model.getClassName();
            }

            // Map equipment items (slots 0-3)
            final List<GameItemRefDto> equipment = new ArrayList<>();
            if (ch.getItems() != null) {
                for (com.openrealm.data.entity.GameItemRefEntity item : ch.getItems()) {
                    if (item.getSlotIdx() != null && item.getSlotIdx() < 4) {
                        equipment.add(this.mapper.map(item, GameItemRefDto.class));
                    }
                }
            }

            results.add(LeaderboardEntryDto.builder()
                    .accountName(entry.getKey())
                    .characterUuid(ch.getCharacterUuid())
                    .characterClass(classId)
                    .className(className)
                    .level(level)
                    .fame(fame)
                    .equipment(equipment)
                    .stats(statsDto)
                    .build());
        }
        return results;
    }

    private static final int MAX_CHARACTERS = 20;
    private static final int MAX_CHARACTERS_DEMO = 1;
    private static final int MAX_CHESTS = 10;
    private static final int MAX_CHESTS_DEMO = 1;

    public PlayerAccountDto createCharacter(final String accountUuid, final Integer classId) throws Exception {
        final long start = Instant.now().toEpochMilli();
        final CharacterClass clazz = CharacterClass.valueOf(classId);
        if (clazz == null)
            throw new Exception("Character class with id " + classId + " does not exist");
        PlayerAccountEntity accountEntity = this.playerAccountRepository.findByAccountUuid(accountUuid);
        if (accountEntity == null)
            throw new Exception("Account with with UUID " + accountUuid + " does not exist");
        // Check demo account character limit
        final boolean isDemoAccount = this.isAccountDemo(accountUuid);
        final int charLimit = isDemoAccount ? MAX_CHARACTERS_DEMO : MAX_CHARACTERS;
        if (accountEntity.getCharacters() != null && accountEntity.getCharacters().size() >= charLimit)
            throw new Exception("Character limit reached (" + charLimit + " max)");
        final CharacterEntity character = CharacterEntity.builder().characterUuid(PlayerDataService.randomUuid())
                .characterClass(classId).build();

        // Equip the player with their starting equipment
        final Map<Integer, GameItem> startingEquip = GameDataManager.getStartingEquipment(clazz);
        if (startingEquip != null) {
            for (Map.Entry<Integer, GameItem> entry : startingEquip.entrySet()) {
                if (entry.getValue() != null) {
                    final GameItemRefEntity toEquipEntity = GameItemRefEntity.from(entry.getKey(), entry.getValue().getItemId());
                    character.addItem(toEquipEntity);
                }
            }
        }

        final CharacterStatsEntity characterStats = CharacterStatsEntity.characterDefaults(classId);
        character.setStats(characterStats);

        accountEntity.addCharacter(character);

        accountEntity = this.playerAccountRepository.save(accountEntity);
        PlayerDataService.log.info("Successfully created character for account {} in {}ms", accountUuid,
                (Instant.now().toEpochMilli() - start));

        return this.mapper.map(accountEntity, PlayerAccountDto.class);
    }

    public void deleteCharacter(final HttpServletRequest request, final String characterUuid) throws Exception {
        this.deleteCharacter(request, characterUuid, false, null);
    }

    public void deleteCharacter(final HttpServletRequest request, final String characterUuid, final boolean bankFame) throws Exception {
        this.deleteCharacter(request, characterUuid, bankFame, null);
    }

    /**
     * Delete a character. When {@code bankFame} is true, fame is credited to
     * the owning account's lifetime {@code accountFame} total before the
     * character is marked deleted.
     *
     * If {@code precomputedFameAmount} is non-null it is credited verbatim —
     * the game server uses this path so it can compute fame from the live
     * in-memory xp on the tick thread (no I/O) without depending on the
     * periodic 12s persist having run. Otherwise the fame is computed here
     * from {@link CharacterEntity#getStats()#getXp()}, which may be up to
     * 12s stale if the player just gained xp.
     *
     * The game server passes bankFame=true on permadeath; user-initiated
     * deletes from the character-select screen leave it false so self-
     * deletes don't earn fame.
     */
    public void deleteCharacter(final HttpServletRequest request, final String characterUuid,
            final boolean bankFame, final Long precomputedFameAmount) throws Exception {
        final long start = Instant.now().toEpochMilli();
        final PlayerAccountEntity account = this.playerAccountRepository.findByCharactersCharacterUuid(characterUuid);
        if (!this.authFilter.accountGuidMatch(account.getAccountUuid(), request)) {
            throw new Exception("Invalid token");
        }
        final Optional<CharacterEntity> characterToDelete = account.getCharacters().stream()
                .filter(character -> character.getCharacterUuid().equals(characterUuid)).findAny();
        if (characterToDelete.isEmpty())
            throw new Exception("Player character with UUID " + characterUuid + " does not exist");
        final CharacterEntity character = characterToDelete.get();
        if (bankFame) {
            try {
                final long earned;
                if (precomputedFameAmount != null) {
                    // Trust the game server's computation — it has live xp.
                    earned = Math.max(0L, precomputedFameAmount);
                } else {
                    // Fallback: compute from possibly-stale persisted xp.
                    final long xp = (character.getStats() != null && character.getStats().getXp() != null)
                            ? character.getStats().getXp() : 0L;
                    earned = GameDataManager.EXPERIENCE_LVLS.getBaseFame(xp);
                }
                if (earned > 0) {
                    final long prev = account.getAccountFame() == null ? 0L : account.getAccountFame();
                    account.setAccountFame(prev + earned);
                    PlayerDataService.log.info("Banked {} fame to account {} from dying character {} (total now {})",
                            earned, account.getAccountUuid(), characterUuid, prev + earned);
                }
            } catch (Exception fameEx) {
                // Don't fail the whole delete if fame banking blows up — log and proceed.
                PlayerDataService.log.warn("Failed to bank fame for dying character {}: {}", characterUuid, fameEx.getMessage());
            }
        }
        character.setDeleted(new Date(Instant.now().toEpochMilli()));
        PlayerDataService.log.info("Successfully deleted character {} in {}ms", characterUuid,
                (Instant.now().toEpochMilli() - start));
        this.playerAccountRepository.save(account);
    }
    
    public List<PlayerAccountDto> getAllAccounts(){
        final List<PlayerAccountDto> results = new ArrayList<>();
        for(PlayerAccountEntity account : this.playerAccountRepository.findAll()) {
            PlayerAccountDto playerAccount = null;
            try {
                playerAccount = this.getAccountByUuid(account.getAccountUuid());
            } catch (Exception e) {
               log.error("Failed to fetch player account. Reason: {}", e);
            }
            results.add(playerAccount);
        }
      
        return results;
    }

    public List<CharacterDto> getPlayerCharacters(final String accountUuid) throws Exception {
        final PlayerAccountDto account = this.getAccountByUuid(accountUuid);
        if (account == null)
            throw new Exception("Player account with UUID " + accountUuid + " was not found");
        return account.getCharacters();
    }

    public PlayerAccountDto createChest(final String accountUuid) throws Exception {
        final PlayerAccountDto account = this.getAccountByUuid(accountUuid);
        if (account == null)
            throw new Exception("Player account with UUID " + accountUuid + " was not found");
        final boolean isDemoAccount = this.isAccountDemo(accountUuid);
        final int chestLimit = isDemoAccount ? MAX_CHESTS_DEMO : MAX_CHESTS;
        if (account.getPlayerVault() != null && account.getPlayerVault().size() >= chestLimit)
            throw new Exception("Vault chest limit reached (" + chestLimit + " max)");

        final ChestDto initialChest = ChestDto.builder().chestUuid(PlayerDataService.randomUuid())
                .ordinal(account.getPlayerVault() != null ? account.getPlayerVault().size() : 0).build();

        account.getPlayerVault().add(initialChest);
        return this.saveAccount(account);
    }

    public PlayerAccountDto saveChests(final String accountUuid, final List<ChestDto> chests) throws Exception {
        final PlayerAccountDto account = this.getAccountByUuid(accountUuid);
        if (account == null)
            throw new Exception("Player account with UUID " + accountUuid + " was not found");

        account.setPlayerVault(chests);
        return this.saveAccount(account);
    }

    /**
     * Atomically deduct fame from an account. Returns the new total. Throws if
     * the account doesn't exist or has insufficient fame. Used by the game
     * server to charge for fame-shop purchases — the server only commits the
     * inventory grant after this call succeeds, so a failed deduction = no
     * item granted.
     */
    public synchronized Long spendAccountFame(final String accountUuid, final long amount) throws Exception {
        if (amount <= 0) throw new Exception("Fame spend amount must be positive");
        final PlayerAccountEntity account = this.playerAccountRepository.findByAccountUuid(accountUuid);
        if (account == null) throw new Exception("Account " + accountUuid + " not found");
        final long current = account.getAccountFame() == null ? 0L : account.getAccountFame();
        if (current < amount) {
            throw new Exception("Insufficient fame: have " + current + ", need " + amount);
        }
        account.setAccountFame(current - amount);
        this.playerAccountRepository.save(account);
        PlayerDataService.log.info("Spent {} fame from account {} (was {}, now {})",
                amount, accountUuid, current, current - amount);
        return current - amount;
    }

    public PlayerAccountDto saveAccount(final PlayerAccountDto dto) {
        PlayerAccountEntity entity = this.mapper.map(dto, PlayerAccountEntity.class);
        // ModelMapper drops nested generic fields (stackCount, enchantments) on
        // GameItemRef. Rebuild the items lists from the DTO so vault & character
        // items round-trip with their stack and enchantment data intact.
        rebuildItemEntitiesFromDto(dto, entity);
        entity = this.playerAccountRepository.save(entity);
        final PlayerAccountDto out = this.mapper.map(entity, PlayerAccountDto.class);
        rebuildItemListsExplicitly(entity, out);
        return out;
    }

    private static void rebuildItemEntitiesFromDto(final PlayerAccountDto src, final PlayerAccountEntity dst) {
        if (src == null || dst == null) return;
        if (src.getCharacters() != null && dst.getCharacters() != null) {
            for (int i = 0; i < src.getCharacters().size() && i < dst.getCharacters().size(); i++) {
                final CharacterDto cd = src.getCharacters().get(i);
                final CharacterEntity ce = dst.getCharacters().get(i);
                if (cd == null || ce == null || cd.getItems() == null) continue;
                ce.removeItems();
                for (final GameItemRefDto id : cd.getItems()) {
                    if (id == null) continue;
                    ce.addItem(toItemEntity(id));
                }
            }
        }
        if (src.getPlayerVault() != null && dst.getPlayerVault() != null) {
            for (int i = 0; i < src.getPlayerVault().size() && i < dst.getPlayerVault().size(); i++) {
                final ChestDto cd = src.getPlayerVault().get(i);
                final ChestEntity ce = dst.getPlayerVault().get(i);
                if (cd == null || ce == null || cd.getItems() == null) continue;
                ce.getItems().clear();
                for (final GameItemRefDto id : cd.getItems()) {
                    if (id == null) continue;
                    ce.addItem(toItemEntity(id));
                }
            }
        }
    }

    public PlayerAccountDto createInitialAccount(final String accountUuid, final String email, final String accountName,
            final Integer characterClass) throws Exception {
        final long start = Instant.now().toEpochMilli();
        // Build a new account with a random uuid and the provided email + accountName;
        final PlayerAccountEntity account = PlayerAccountEntity.builder().accountEmail(email).accountName(accountName)
                .accountUuid(accountUuid).build();

        // Create a single chest with one item in it
        final ChestEntity initialChest = ChestEntity.builder().chestUuid(PlayerDataService.randomUuid()).ordinal(0)
                .build();
        // Create a new GameItemRef and put it in this chest

        final GameItemRefEntity gameItemDBow = GameItemRefEntity.from(0, 47);
        // Add the item to the chest
        initialChest.addItem(gameItemDBow);

        // Build a character from the provided classId, give it a weapon and give it
        // default stats from GameDataManager
        final CharacterEntity character = CharacterEntity.builder().characterUuid(PlayerDataService.randomUuid())
                .characterClass(characterClass).build();

        // Equip the player with their starting equipment
        final CharacterClass clazz = CharacterClass.valueOf(characterClass);
        if (clazz != null) {
            final Map<Integer, GameItem> startingEquip = GameDataManager.getStartingEquipment(clazz);
            if (startingEquip != null) {
                for (Map.Entry<Integer, GameItem> entry : startingEquip.entrySet()) {
                    if (entry.getValue() != null) {
                        final GameItemRefEntity toEquipEntity = GameItemRefEntity.from(entry.getKey(), entry.getValue().getItemId());
                        character.addItem(toEquipEntity);
                    }
                }
            }
        }

        final CharacterStatsEntity characterStats = CharacterStatsEntity.characterDefaults(characterClass);
        character.setStats(characterStats);

        account.addCharacter(character);
        account.addChest(initialChest);

        final PlayerAccountEntity finalAccount = this.playerAccountRepository.save(account);

        // this.replaceChestItem(initialChest.getChestUuid(),
        // gameItemDBow.getItemUuid(), null);
        PlayerDataService.log.info("Successfully created account for user {} in {}ms", finalAccount.getAccountEmail(),
                (Instant.now().toEpochMilli() - start));
        return this.mapper.map(finalAccount, PlayerAccountDto.class);
    }

    /**
     * Create a player account entry with no characters and no chests (for guest/demo accounts).
     */
    public PlayerAccountDto createEmptyAccount(final String accountUuid, final String email, final String accountName)
            throws Exception {
        final long start = Instant.now().toEpochMilli();
        final PlayerAccountEntity account = PlayerAccountEntity.builder().accountEmail(email).accountName(accountName)
                .accountUuid(accountUuid).build();
        final PlayerAccountEntity finalAccount = this.playerAccountRepository.save(account);
        PlayerDataService.log.info("Successfully created empty guest account for user {} in {}ms",
                finalAccount.getAccountEmail(), (Instant.now().toEpochMilli() - start));
        return this.mapper.map(finalAccount, PlayerAccountDto.class);
    }

    /**
     * Check if the given account has the OPENREALM_DEMO provision.
     */
    private boolean isAccountDemo(final String accountUuid) {
        try {
            final AccountDto authAccount = this.accountService.getAccountByGuid(accountUuid);
            return authAccount != null && authAccount.isDemo();
        } catch (Exception e) {
            PlayerDataService.log.warn("Could not check demo status for account {}: {}", accountUuid, e.getMessage());
            return false;
        }
    }

    public boolean replaceChestItem(final String accountUuid, final String chestUuid, final String targetItemUuid,
            final GameItemRefEntity replacement) throws Exception {
        final PlayerAccountEntity account = this.playerAccountRepository.findByAccountUuid(accountUuid);
        final ChestEntity targetChest = this.playerChestRepository.findByChestUuid(chestUuid);
        boolean success = false;
        if (targetChest == null)
            throw new Exception("Chest with UUID " + chestUuid + " does not exist");
        final GameItemRefEntity targetItem = this.gameItemRefRepository.findByItemUuid(targetItemUuid);
        if (targetItem == null)
            throw new Exception("Target item with UUID " + targetItemUuid + " does not exist");
        if (replacement == null) {
            final Optional<GameItemRefEntity> itemInChest = targetChest.getItems().stream()
                    .filter(item -> item.getItemUuid().equals(targetItemUuid)).findAny();
            if (itemInChest.isEmpty())
                throw new Exception(
                        "Target item with UUID " + targetItemUuid + " does not exist in chest with UUID " + chestUuid);
            final GameItemRefEntity toRemove = itemInChest.get();
            success = targetChest.removeItem(targetItem);
            this.deleteGameItem(toRemove);
        } else {
            final Optional<GameItemRefEntity> itemInChest = targetChest.getItems().stream()
                    .filter(item -> item.getItemUuid().equals(targetItemUuid)).findAny();
            if (itemInChest.isEmpty())
                throw new Exception(
                        "Target item with UUID " + targetItemUuid + " does not exist in chest with UUID " + chestUuid);
            final GameItemRefEntity toRemove = itemInChest.get();
            success = targetChest.removeItem(targetItem);
            this.deleteGameItem(toRemove);
            targetChest.addItem(replacement);
        }
        this.playerAccountRepository.save(account);
        return success;
    }

    public void deleteGameItem(final GameItemRefEntity toDelete) {
        this.gameItemRefRepository.delete(toDelete);
    }

    public PlayerAccountDto getAccountById(final String accountId) throws Exception {
        final long start = Instant.now().toEpochMilli();
        final Optional<PlayerAccountEntity> entity = this.playerAccountRepository.findById(accountId);
        if (entity.isPresent()) {
            PlayerDataService.log.debug("Fetched account by id {} in {}ms", accountId,
                    (Instant.now().toEpochMilli() - start));
            return this.mapper.map(entity, PlayerAccountDto.class);
        }
        throw new Exception("PlayerAccount with id " + accountId + " not found");
    }

    public PlayerAccountDto getAccountByEmail(final String email) throws Exception {
        final long start = Instant.now().toEpochMilli();
        final PlayerAccountEntity entity = this.playerAccountRepository.findByAccountEmail(email);
        if (entity != null) {
            PlayerDataService.log.info("Fetched account by email {} in {}ms", email,
                    (Instant.now().toEpochMilli() - start));
            return this.mapper.map(entity, PlayerAccountDto.class);
        }
        throw new Exception("PlayerAccount with email " + email + " not found");
    }

    public PlayerAccountDto getAccountByUuid(final String accountUuid) throws Exception {
        final long start = Instant.now().toEpochMilli();
        final PlayerAccountEntity entity = this.playerAccountRepository.findByAccountUuid(accountUuid);
        if (entity != null) {
            PlayerDataService.log.debug("Fetched account by UUID {} in {}ms", accountUuid,
                    (Instant.now().toEpochMilli() - start));
            final PlayerAccountDto dto = this.mapper.map(entity, PlayerAccountDto.class);
            // ModelMapper can silently drop nested generic-list fields (notably
            // GameItemRefDto.enchantments). Rebuild item lists explicitly so the
            // game server always receives stackCount + enchantments verbatim.
            rebuildItemListsExplicitly(entity, dto);
            return dto;
        }
        throw new Exception("PlayerAccount with account UUID " + accountUuid + " not found");
    }

    /** Replace each character/chest's items with explicit field-level copies of the entity items. */
    private static void rebuildItemListsExplicitly(final PlayerAccountEntity src, final PlayerAccountDto dst) {
        if (src == null || dst == null) return;
        if (src.getCharacters() != null && dst.getCharacters() != null) {
            for (int i = 0; i < src.getCharacters().size() && i < dst.getCharacters().size(); i++) {
                final CharacterEntity ce = src.getCharacters().get(i);
                final CharacterDto cd = dst.getCharacters().get(i);
                if (ce != null && cd != null && ce.getItems() != null) {
                    final List<GameItemRefDto> rebuilt = new ArrayList<>(ce.getItems().size());
                    for (final GameItemRefEntity ie : ce.getItems()) {
                        final GameItemRefDto id = toItemDto(ie);
                        if (id != null) rebuilt.add(id);
                    }
                    cd.setItems(rebuilt);
                }
            }
        }
        if (src.getPlayerVault() != null && dst.getPlayerVault() != null) {
            for (int i = 0; i < src.getPlayerVault().size() && i < dst.getPlayerVault().size(); i++) {
                final ChestEntity ce = src.getPlayerVault().get(i);
                final ChestDto cd = dst.getPlayerVault().get(i);
                if (ce != null && cd != null && ce.getItems() != null) {
                    final java.util.Set<GameItemRefDto> rebuilt = new java.util.HashSet<>();
                    for (final GameItemRefEntity ie : ce.getItems()) {
                        final GameItemRefDto id = toItemDto(ie);
                        if (id != null) rebuilt.add(id);
                    }
                    cd.setItems(rebuilt);
                }
            }
        }
    }

    public static String randomUuid() {
        return UUID.randomUUID().toString();
    }

    /**
     * Explicit DTO -> Entity copy for an inventory item. Avoids ModelMapper's
     * silent-failure mode on the new {@link EnchantmentDto} list. If anything
     * goes wrong with enchantments specifically, we still produce a valid item
     * entity (without enchantments) so the player doesn't lose the item itself.
     */
    private static GameItemRefEntity toItemEntity(final GameItemRefDto dto) {
        final GameItemRefEntity entity = new GameItemRefEntity();
        entity.setGameItemRefId(dto.getGameItemRefId());
        entity.setItemId(dto.getItemId());
        entity.setSlotIdx(dto.getSlotIdx());
        entity.setItemUuid(dto.getItemUuid());
        entity.setStackCount(dto.getStackCount() != null ? dto.getStackCount() : Integer.valueOf(1));
        if (dto.getEnchantments() != null && !dto.getEnchantments().isEmpty()) {
            final java.util.List<EnchantmentEntity> ench = new ArrayList<>(dto.getEnchantments().size());
            for (final EnchantmentDto e : dto.getEnchantments()) {
                if (e == null) continue;
                ench.add(new EnchantmentEntity(e.getStatId(), e.getDeltaValue(),
                        e.getPixelX(), e.getPixelY(), e.getPixelColor()));
            }
            entity.setEnchantments(ench);
        }
        return entity;
    }

    /** Inverse of {@link #toItemEntity(GameItemRefDto)} — used by load paths. */
    public static GameItemRefDto toItemDto(final GameItemRefEntity entity) {
        if (entity == null) return null;
        final GameItemRefDto dto = new GameItemRefDto();
        dto.setGameItemRefId(entity.getGameItemRefId());
        dto.setItemId(entity.getItemId());
        dto.setSlotIdx(entity.getSlotIdx());
        dto.setItemUuid(entity.getItemUuid());
        dto.setStackCount(entity.getStackCount() != null ? entity.getStackCount() : Integer.valueOf(1));
        if (entity.getEnchantments() != null && !entity.getEnchantments().isEmpty()) {
            final java.util.List<EnchantmentDto> ench = new ArrayList<>(entity.getEnchantments().size());
            for (final EnchantmentEntity e : entity.getEnchantments()) {
                if (e == null) continue;
                ench.add(new EnchantmentDto(e.getStatId(), e.getDeltaValue(),
                        e.getPixelX(), e.getPixelY(), e.getPixelColor()));
            }
            dto.setEnchantments(ench);
        }
        return dto;
    }
}
