import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type { EncounterUnit, Position, MapSize, MapGridConfig, MapRegion } from '../types';
import {
  calculateDistance,
  columnIndexToLabel,
  coordinateToLabel
} from '../utils/mapUtils';
import { NearbyEntitiesModal } from './NearbyEntitiesModal';
import { CreatureJumpModal } from './CreatureJumpModal';
import { RegionJumpModal } from './RegionJumpModal';
import { UnitActionModal } from './UnitActionModal';
import { mapGridService } from '../services/MapGridService';
import { isStepBlockedByWall } from '../utils/coverCalculation';
import { hasCommandModifier, useAnnouncer } from './uiHelpers';

interface CombatMapProps {
  units: EncounterUnit[];
  mapSize?: MapSize;
  activeTurnUnitId?: string;
  onUpdateUnitPosition: (instanceId: string, newPos: Position) => void;
  onOpenOperations?: (unit: EncounterUnit, mapCell?: Position) => void;
  onOpenDetails?: (unit: EncounterUnit, mapCell?: Position) => void;
  externalRadarUnit?: EncounterUnit | null;
  onResetExternalRadarUnit?: () => void;
  dmMapUrl?: string;
  playerMapUrl?: string;
  mapName?: string;
  isExternalModalOpen?: boolean;
}

const DEFAULT_MAP_SIZE: MapSize = { width: 20, height: 20 };

/**
 * Board geometry in CSS pixels. The battlemap image is scaled so that one of its squares is exactly
 * CELL_PX wide and placed LABEL_COL_PX from the left and HEADER_ROW_PX from the top of the table, so
 * the table has to be laid out at exactly these sizes: fixed layout with an explicit width, and
 * border-box cells without padding (the .combat-grid-* rules in index.css use the same numbers).
 */
const CELL_PX = 42;
const HEADER_ROW_PX = 32;
const LABEL_COL_PX = 38;

interface GridCellProps {
  colIdx: number;
  rowIdx: number;
  isFocused: boolean;
  occupant?: EncounterUnit;
  isMovingThis?: boolean;
  isActiveTurn?: boolean;
  hasMapArt: boolean;
  cellAriaLabel: string;
  coordLabel: string;
}

/**
 * Memoized individual grid cell to avoid re-evaluating unchanged cells on arrow navigation.
 * With up to 3,000 cells per map, this ensures that moving cursor from Cell A to Cell B
 * only re-renders 2 cells instead of 3,000 cells, keeping navigation latency under 1ms.
 */
const GridCell = React.memo(function GridCell({
  colIdx,
  rowIdx,
  isFocused,
  occupant,
  isMovingThis,
  isActiveTurn,
  hasMapArt,
  cellAriaLabel,
  coordLabel
}: GridCellProps) {
  const cellClass = `combat-grid-cell ${hasMapArt ? 'with-art' : 'no-art'} ${isFocused ? 'is-focused' : ''}`;

  return (
    <td
      role="gridcell"
      data-cell={`${colIdx}-${rowIdx}`}
      aria-label={cellAriaLabel}
      tabIndex={isFocused ? 0 : -1}
      className={cellClass}
    >
      {occupant ? (
        <>
          <div
            aria-hidden="true"
            style={{
              width: '32px',
              height: '32px',
              margin: '0 auto',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 'bold',
              fontSize: '0.8rem',
              color: '#fff',
              backgroundColor: occupant.isPlayer ? '#0d6efd' : '#dc3545',
              border: isMovingThis
                ? '2px dashed #00ffcc'
                : isActiveTurn
                  ? '2px solid #ffc107'
                  : '1px solid rgba(255,255,255,0.4)',
              boxShadow: isFocused ? '0 0 8px rgba(255,193,7,0.8)' : undefined
            }}
            title={`${occupant.name} (${coordLabel}) - Click for options`}
          >
            {occupant.name.slice(0, 2).toUpperCase()}
          </div>
          {/* Explicit screen reader text so assistive tech never reads raw dots or letters */}
          <span className="sr-only">
            {cellAriaLabel}
          </span>
        </>
      ) : (
        <>
          {/* Middle dot is explicitly aria-hidden so screen readers never say 'middle dot' */}
          <span
            aria-hidden="true"
            style={{
              fontSize: '0.65rem',
              color: hasMapArt ? 'rgba(255, 255, 255, 0.45)' : '#343a40',
              userSelect: 'none'
            }}
          >
            ·
          </span>
          <span className="sr-only">Empty</span>
        </>
      )}
    </td>
  );
});

export function CombatMap({
  units,
  mapSize = DEFAULT_MAP_SIZE,
  activeTurnUnitId,
  onUpdateUnitPosition,
  onOpenOperations,
  onOpenDetails,
  externalRadarUnit,
  onResetExternalRadarUnit,
  dmMapUrl,
  playerMapUrl,
  isExternalModalOpen
}: CombatMapProps) {
  const [focusedCell, setFocusedCell] = useState<Position>({ x: 0, y: 0 });
  const [moveModeUnit, setMoveModeUnit] = useState<EncounterUnit | null>(null);
  const [moveOrigin, setMoveOrigin] = useState<Position | null>(null);
  const [liveAnnouncement, setLiveAnnouncement] = useAnnouncer();
  const [isRadarOpen, setIsRadarOpen] = useState(false);
  const [radarOriginUnit, setRadarOriginUnit] = useState<EncounterUnit | null>(null);
  const [isJumpOpen, setIsJumpOpen] = useState(false);
  const [isMapBackdropVisible, setIsMapBackdropVisible] = useState(true);
  const [mapVersion, setMapVersion] = useState<'dm' | 'player'>('dm');
  const activeMapUrl = (mapVersion === 'player' && playerMapUrl) ? playerMapUrl : (dmMapUrl || playerMapUrl);

  const [gridConfig, setGridConfig] = useState<MapGridConfig | null>(() =>
    mapGridService.getCachedGrid(activeMapUrl)
  );

  useEffect(() => {
    let isCancelled = false;
    if (activeMapUrl) {
      mapGridService.getOrDetectGrid(activeMapUrl, mapSize).then(cfg => {
        if (!isCancelled && cfg) setGridConfig(cfg);
      });
    }
    return () => {
      isCancelled = true;
    };
  }, [activeMapUrl, mapSize]);

  // Effective dimensions for the game board (scales to the true battlemap grid and attaches regions)
  const effectiveMapSize: MapSize = useMemo(() => {
    const currentGrid = activeMapUrl ? gridConfig : null;
    if (currentGrid && currentGrid.columns > 0 && currentGrid.rows > 0) {
      return {
        width: currentGrid.columns,
        height: currentGrid.rows,
        cellPitch: currentGrid.cellPitch,
        offsetX: currentGrid.offsetX,
        offsetY: currentGrid.offsetY,
        regions: currentGrid.regions || mapSize?.regions,
        walls: currentGrid.walls || mapSize?.walls
      };
    }
    return mapSize || DEFAULT_MAP_SIZE;
  }, [activeMapUrl, gridConfig, mapSize]);

  // Scaled background alignment math to map board cells (CELL_PX) onto the battlemap's squares
  const { backdropSize, backdropPosition } = useMemo(() => {
    const D = CELL_PX;
    const currentGrid = activeMapUrl ? gridConfig : null;
    if (currentGrid && currentGrid.cellPitch > 0) {
      const s = currentGrid.cellPitch;
      const scale = D / s;
      const x0 = currentGrid.offsetX ?? 0;
      const y0 = currentGrid.offsetY ?? 0;
      const imgW = currentGrid.imageWidth || (currentGrid.columns * s + x0);
      const imgH = currentGrid.imageHeight || (currentGrid.rows * s + y0);

      const scaledW = imgW * scale;
      const scaledH = imgH * scale;
      const scaledX = x0 * scale;
      const scaledY = y0 * scale;

      return {
        backdropSize: `${scaledW}px ${scaledH}px`,
        backdropPosition: `${-scaledX}px ${-scaledY}px`
      };
    }
    return {
      backdropSize: `${effectiveMapSize.width * D}px ${effectiveMapSize.height * D}px`,
      backdropPosition: '0 0'
    };
  }, [activeMapUrl, gridConfig, effectiveMapSize.width, effectiveMapSize.height]);

  // Unit Action Modal state (menu when clicking/pressing Enter on monster/unit)
  const [actionModalUnit, setActionModalUnit] = useState<EncounterUnit | null>(null);
  const [actionModalPos, setActionModalPos] = useState<Position | null>(null);
  const [isActionModalOpen, setIsActionModalOpen] = useState(false);
  const [isRegionJumpOpen, setIsRegionJumpOpen] = useState(false);

  const tableRef = useRef<HTMLTableElement>(null);

  const closeActionModal = () => {
    setIsActionModalOpen(false);
    setActionModalUnit(null);
    setActionModalPos(null);
  };

  // Focus a grid cell (row/col are offset by one for the header row/column).
  const focusCell = (pos: Position, delayMs?: number) => {
    const doFocus = () => tableRef.current?.rows[pos.y + 1]?.cells[pos.x + 1]?.focus();
    if (delayMs === undefined) doFocus();
    else setTimeout(doFocus, delayMs);
  };
  const mapSectionRef = useRef<HTMLElement>(null);
  const radarTriggerRef = useRef<HTMLButtonElement>(null);
  const jumpTriggerRef = useRef<HTMLButtonElement>(null);
  const regionJumpTriggerRef = useRef<HTMLButtonElement>(null);
  const focusBoardTriggerRef = useRef<HTMLButtonElement>(null);
  const isInternalFocusChange = useRef(false);
  const radarOpenedFromCellRef = useRef(false);
  const radarReturnCellRef = useRef<Position | null>(null);
  const jumpOpenedFromCellRef = useRef<Position | null>(null);
  const regionJumpOpenedFromCellRef = useRef<Position | null>(null);

  const isAnyModalOpen = isActionModalOpen || isJumpOpen || isRegionJumpOpen || isRadarOpen;
  const isModalActive = isAnyModalOpen || Boolean(isExternalModalOpen);

  // Fast coordinate lookup for units: `${x},${y}` -> EncounterUnit
  const unitByCoord = useMemo(() => {
    const map = new Map<string, EncounterUnit>();
    units.forEach(u => {
      if (u.position) {
        map.set(`${u.position.x},${u.position.y}`, u);
      }
    });
    return map;
  }, [units]);

  // Fast coordinate lookup for semantic irregular regions: `${x},${y}` -> MapRegion
  const regionByCoord = useMemo(() => {
    const map = new Map<string, MapRegion>();
    const regions = gridConfig?.regions || effectiveMapSize.regions;
    if (regions) {
      for (const reg of regions) {
        for (const cell of reg.cells) {
          map.set(cell, reg);
        }
      }
    }
    return map;
  }, [gridConfig?.regions, effectiveMapSize.regions]);

  const getRegionLabel = useCallback((pos: Position): string => {
    const reg = regionByCoord.get(`${pos.x},${pos.y}`);
    if (!reg) return '';
    const idPart = reg.id && reg.id !== 'ocean' ? ` - ${reg.id}` : '';
    return ` (${reg.name}${idPart})`;
  }, [regionByCoord]);

  // All occupied cells sorted in board reading order
  const occupiedCells = useMemo(() => {
    return units
      .filter(u => !!u.position)
      .map(u => u.position!)
      .sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));
  }, [units]);

  const focusedOccupant = unitByCoord.get(`${focusedCell.x},${focusedCell.y}`) || null;

  const openRadarForUnit = useCallback((unitOverride?: EncounterUnit | null, fromCell = false, returnCell?: Position) => {
    radarOpenedFromCellRef.current = fromCell;
    radarReturnCellRef.current = returnCell || unitOverride?.position || focusedCell;
    const candidate =
      unitOverride ||
      focusedOccupant ||
      units.find(u => u.instanceId === activeTurnUnitId) ||
      units.find(u => !u.isPlayer && !!u.position) ||
      units.find(u => !!u.position) ||
      null;
    setRadarOriginUnit(candidate);
    setIsRadarOpen(true);
  }, [focusedOccupant, units, activeTurnUnitId, focusedCell]);

  useEffect(() => {
    if (externalRadarUnit) {
      const timer = setTimeout(() => {
        openRadarForUnit(externalRadarUnit);
        onResetExternalRadarUnit?.();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [externalRadarUnit, onResetExternalRadarUnit, openRadarForUnit]);

  // Direct O(1) focus dispatch: Indexed row and cell access avoids O(N) querySelector scanning
  useEffect(() => {
    if (isInternalFocusChange.current) {
      if (!isAnyModalOpen) {
        focusCell(focusedCell);
      }
      isInternalFocusChange.current = false;
    }
  }, [focusedCell, isAnyModalOpen]);

  // Global keyboard shortcuts: Alt+B (Focus Board), Alt+E (Radar), Alt+J (Jump)
  useEffect(() => {
    const handleGlobalShortcuts = (e: KeyboardEvent) => {
      if (e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        focusCell(focusedCell);
        const regionTag = getRegionLabel(focusedCell);
        setLiveAnnouncement(`Combat Map board focused at cell ${coordinateToLabel(focusedCell)}${regionTag}. Use arrow keys to navigate, Escape to exit.`);
      } else if (e.altKey && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        const isFromCell = document.activeElement?.getAttribute('role') === 'gridcell';
        if (isFromCell && document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        openRadarForUnit(undefined, isFromCell, focusedCell);
      } else if (e.altKey && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        const isFromCell = document.activeElement?.getAttribute('role') === 'gridcell';
        jumpOpenedFromCellRef.current = isFromCell ? focusedCell : null;
        if (isFromCell && document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        setIsJumpOpen(prev => !prev);
      } else if (e.altKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        if (effectiveMapSize.regions && effectiveMapSize.regions.length > 0) {
          const isFromCell = document.activeElement?.getAttribute('role') === 'gridcell';
          regionJumpOpenedFromCellRef.current = isFromCell ? focusedCell : null;
          if (isFromCell && document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
          }
          setIsRegionJumpOpen(prev => !prev);
        }
      }
    };
    window.addEventListener('keydown', handleGlobalShortcuts);
    return () => window.removeEventListener('keydown', handleGlobalShortcuts);
  }, [focusedCell, openRadarForUnit, getRegionLabel, effectiveMapSize.regions, setLiveAnnouncement]);

  const moveFocusTo = useCallback((newPos: Position) => {
    const clampedX = Math.max(0, Math.min(effectiveMapSize.width - 1, newPos.x));
    const clampedY = Math.max(0, Math.min(effectiveMapSize.height - 1, newPos.y));
    isInternalFocusChange.current = true;
    setFocusedCell({ x: clampedX, y: clampedY });

    const coord = coordinateToLabel({ x: clampedX, y: clampedY });
    const regionTag = getRegionLabel({ x: clampedX, y: clampedY });
    const occupant = unitByCoord.get(`${clampedX},${clampedY}`);

    if (moveModeUnit && moveOrigin) {
      const dist = calculateDistance(moveOrigin, { x: clampedX, y: clampedY });
      const occupancyNote = occupant && occupant.instanceId !== moveModeUnit.instanceId
        ? ` (Occupied by ${occupant.name})`
        : '';
      setLiveAnnouncement(`Moved ${moveModeUnit.name} to ${coord}${regionTag}${occupancyNote}. ${dist} ft from start. Press Enter to place.`);
    }
    // On regular cursor navigation, aria-label on the focused cell announces coordinates & region natively without double-speaking!
  }, [effectiveMapSize.width, effectiveMapSize.height, moveModeUnit, moveOrigin, unitByCoord, getRegionLabel, setLiveAnnouncement]);

  // Jump to Next / Previous occupied cell
  const jumpToOccupied = useCallback((forward: boolean) => {
    if (occupiedCells.length === 0) return;
    const currentIndex = occupiedCells.findIndex(
      pos => pos.x === focusedCell.x && pos.y === focusedCell.y
    );

    let nextIndex: number;
    if (currentIndex === -1) {
      nextIndex = forward ? 0 : occupiedCells.length - 1;
    } else {
      nextIndex = forward
        ? (currentIndex + 1) % occupiedCells.length
        : (currentIndex - 1 + occupiedCells.length) % occupiedCells.length;
    }

    moveFocusTo(occupiedCells[nextIndex]);
  }, [occupiedCells, focusedCell, moveFocusTo]);

  // Jump focus to current turn combatant
  const jumpToActiveCombatant = useCallback(() => {
    if (!activeTurnUnitId) return;
    const activeUnit = units.find(u => u.instanceId === activeTurnUnitId);
    if (activeUnit?.position) {
      moveFocusTo(activeUnit.position);
      const regionTag = getRegionLabel(activeUnit.position);
      setLiveAnnouncement(`Focused on active turn: ${activeUnit.name} at ${coordinateToLabel(activeUnit.position)}${regionTag}.`);
    }
  }, [activeTurnUnitId, units, moveFocusTo, getRegionLabel, setLiveAnnouncement]);

  const handleStartMoveMode = (unit: EncounterUnit) => {
    if (!unit.position) return;
    setMoveModeUnit(unit);
    setMoveOrigin(unit.position);
    setFocusedCell(unit.position);
    isInternalFocusChange.current = true;
    const regionTag = getRegionLabel(unit.position);
    setLiveAnnouncement(
      `Move mode started for ${unit.name} at ${coordinateToLabel(unit.position)}${regionTag}. Use arrow keys to navigate around the board (hold Ctrl to pass through walls), Enter to confirm, Escape to cancel.`
    );
  };

  const handleConfirmMove = (targetPos?: Position) => {
    if (!moveModeUnit || !moveOrigin) return;
    const dest = targetPos || focusedCell;

    // Check if target cell is occupied by a different unit
    const occupant = unitByCoord.get(`${dest.x},${dest.y}`);
    if (occupant && occupant.instanceId !== moveModeUnit.instanceId) {
      const regionTag = getRegionLabel(dest);
      setLiveAnnouncement(
        `Cannot place ${moveModeUnit.name} at ${coordinateToLabel(dest)}${regionTag}: Space occupied by ${occupant.name}.`
      );
      return;
    }

    const dist = calculateDistance(moveOrigin, dest);
    const regionTag = getRegionLabel(dest);
    onUpdateUnitPosition(moveModeUnit.instanceId, dest);
    setLiveAnnouncement(
      `${moveModeUnit.name} placed at ${coordinateToLabel(dest)}${regionTag}. Moved ${dist} feet.`
    );
    setMoveModeUnit(null);
    setMoveOrigin(null);
  };

  const handleCancelMove = () => {
    if (!moveModeUnit || !moveOrigin) return;
    moveFocusTo(moveOrigin);
    const regionTag = getRegionLabel(moveOrigin);
    setLiveAnnouncement(
      `Move cancelled. ${moveModeUnit.name} returned to ${coordinateToLabel(moveOrigin)}${regionTag}.`
    );
    setMoveModeUnit(null);
    setMoveOrigin(null);
  };

  // Opens action menu for a given unit
  const openUnitActionMenu = (unit: EncounterUnit, pos: Position) => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    setActionModalUnit(unit);
    setActionModalPos(pos);
    setIsActionModalOpen(true);
  };

  // Cell click handler
  const handleCellClick = (pos: Position) => {
    if (moveModeUnit) {
      moveFocusTo(pos);
      handleConfirmMove(pos);
    } else {
      const occupant = unitByCoord.get(`${pos.x},${pos.y}`);
      if (occupant) {
        setFocusedCell(pos);
        openUnitActionMenu(occupant, pos);
      } else {
        moveFocusTo(pos);
      }
    }
  };

  const handleArrowMove = useCallback((fromPos: Position, targetPos: Position, isCtrlHeld: boolean) => {
    // If moving a unit in Move Mode
    if (moveModeUnit) {
      // Bounds check
      if (
        targetPos.x < 0 || targetPos.x >= effectiveMapSize.width ||
        targetPos.y < 0 || targetPos.y >= effectiveMapSize.height
      ) {
        setLiveAnnouncement('Cannot move outside map boundary.');
        return;
      }

      // Check wall blocking
      const block = isStepBlockedByWall(fromPos, targetPos, effectiveMapSize.walls);
      if (block.blocked && !isCtrlHeld) {
        const wallDesc = block.wallName || (block.wallType === 'door_closed' ? 'Closed Door' : 'Wall');
        setLiveAnnouncement(`Cannot move through ${wallDesc}. Hold Ctrl while pressing arrow keys to pass through.`);
        return;
      }

      if (block.blocked && isCtrlHeld) {
        const wallDesc = block.wallName || 'wall';
        const dist = calculateDistance(moveOrigin || fromPos, targetPos);
        const coord = coordinateToLabel(targetPos);
        const regionTag = getRegionLabel(targetPos);
        moveFocusTo(targetPos);
        setLiveAnnouncement(`Moved ${moveModeUnit.name} through ${wallDesc} (Ctrl bypass) to ${coord}${regionTag}. ${dist} ft from start. Press Enter to place.`);
        return;
      }

      moveFocusTo(targetPos);
      return;
    }

    // Standard cursor navigation
    moveFocusTo(targetPos);
  }, [moveModeUnit, moveOrigin, effectiveMapSize.width, effectiveMapSize.height, effectiveMapSize.walls, moveFocusTo, getRegionLabel, setLiveAnnouncement]);

  // Cell keyboard listener
  const handleCellKeyDown = (e: React.KeyboardEvent<HTMLElement>, pos: Position) => {
    // Arrow Navigation around board
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      handleArrowMove(pos, { x: pos.x, y: pos.y - 1 }, e.ctrlKey);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      handleArrowMove(pos, { x: pos.x, y: pos.y + 1 }, e.ctrlKey);
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      handleArrowMove(pos, { x: pos.x - 1, y: pos.y }, e.ctrlKey);
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      handleArrowMove(pos, { x: pos.x + 1, y: pos.y }, e.ctrlKey);
      return;
    }

    // ARIA Grid Bounds Keys
    if (e.key === 'Home') {
      e.preventDefault();
      if (e.ctrlKey) {
        moveFocusTo({ x: 0, y: 0 });
      } else {
        moveFocusTo({ x: 0, y: pos.y });
      }
      return;
    }
    if (e.key === 'End') {
      e.preventDefault();
      if (e.ctrlKey) {
        moveFocusTo({ x: effectiveMapSize.width - 1, y: effectiveMapSize.height - 1 });
      } else {
        moveFocusTo({ x: effectiveMapSize.width - 1, y: pos.y });
      }
      return;
    }

    // Quick creature cycle
    if (e.key === ']' || (e.key === 'n' && !e.altKey && !e.ctrlKey)) {
      e.preventDefault();
      jumpToOccupied(true);
      return;
    }
    if (e.key === '[' || (e.key === 'p' && !e.altKey && !e.ctrlKey)) {
      e.preventDefault();
      jumpToOccupied(false);
      return;
    }

    // Quick single-key triggers on occupied cells
    const occupant = unitByCoord.get(`${pos.x},${pos.y}`);
    if (occupant && !moveModeUnit && !hasCommandModifier(e)) {
      if (e.key.toLowerCase() === 'm') {
        e.preventDefault();
        handleStartMoveMode(occupant);
        return;
      }
      if (e.key.toLowerCase() === 'a' && onOpenOperations && !occupant.isPlayer) {
        e.preventDefault();
        onOpenOperations(occupant, pos);
        return;
      }
      if (e.key.toLowerCase() === 'd' && onOpenDetails) {
        e.preventDefault();
        onOpenDetails(occupant, pos);
        return;
      }
    }

    // Enter / Space: In move mode confirms move, otherwise opens Action Menu for occupied cell
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (moveModeUnit) {
        handleConfirmMove();
      } else if (occupant) {
        openUnitActionMenu(occupant, pos);
      }
      return;
    }

    // Escape cancels move mode or exits the board to restore Virtual Cursor
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (moveModeUnit) {
        handleCancelMove();
      } else {
        // Exit application container and restore virtual PC cursor by focusing Focus Board button
        focusBoardTriggerRef.current?.focus();
        setLiveAnnouncement('Exited Combat Map board. Virtual cursor restored.');
      }
      return;
    }
  };

  // Event delegation on table body: eliminates 6,000 closures on each render
  const handleTableClick = (e: React.MouseEvent<HTMLTableSectionElement>) => {
    const cell = (e.target as HTMLElement).closest<HTMLTableCellElement>('td[data-cell]');
    if (!cell) return;
    const [x, y] = cell.getAttribute('data-cell')!.split('-').map(Number);
    handleCellClick({ x, y });
  };

  const handleTableKeyDown = (e: React.KeyboardEvent<HTMLTableSectionElement>) => {
    const cell = (e.target as HTMLElement).closest<HTMLTableCellElement>('td[data-cell]');
    if (!cell) return;
    const [x, y] = cell.getAttribute('data-cell')!.split('-').map(Number);
    handleCellKeyDown(e, { x, y });
  };

  return (
    <section
      ref={mapSectionRef}
      aria-labelledby="map-heading"
      className="combat-map-section"
      style={{
        marginTop: '2rem',
        padding: '1.5rem',
        backgroundColor: '#1a1d20',
        color: '#f8f9fa',
        borderRadius: '8px',
        border: '1px solid #343a40'
      }}
    >
      {/* Accessible Live Region for Screen Reader Announcements */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        style={{ position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0,0,0,0)' }}
      >
        {liveAnnouncement}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', gap: '0.75rem' }}>
        <div>
          <h2 id="map-heading" style={{ margin: 0, fontSize: '1.4rem' }}>
            Combat Map ({effectiveMapSize.width * 5}x{effectiveMapSize.height * 5} ft)
          </h2>
          <span style={{ fontSize: '0.85rem', color: '#adb5bd' }}>
            Grid coordinates A1 to {coordinateToLabel({ x: effectiveMapSize.width - 1, y: effectiveMapSize.height - 1 })}. Use arrow keys to navigate. Press Escape to exit board. Click or press Enter on a monster for its menu.
          </span>
        </div>

        {/* Toolbar Controls */}
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button
            ref={focusBoardTriggerRef}
            type="button"
            onClick={() => {
              isInternalFocusChange.current = true;
              setFocusedCell({ ...focusedCell });
              const regionTag = getRegionLabel(focusedCell);
              setLiveAnnouncement(`Combat Map board focused at cell ${coordinateToLabel(focusedCell)}${regionTag}. Use arrow keys to navigate, Escape to exit.`);
            }}
            style={{ padding: '0.4rem 0.8rem', cursor: 'pointer', backgroundColor: '#198754', color: '#fff', fontWeight: 'bold', border: 'none', borderRadius: '4px' }}
          >
            Focus Board (Alt+B)
          </button>
          {activeTurnUnitId && (
            <button
              type="button"
              onClick={jumpToActiveCombatant}
              style={{ padding: '0.4rem 0.8rem', cursor: 'pointer', backgroundColor: '#e0a800', color: '#000', fontWeight: 'bold', border: 'none', borderRadius: '4px' }}
            >
              Focus Active Turn
            </button>
          )}
          <button
            ref={jumpTriggerRef}
            type="button"
            onClick={() => {
              jumpOpenedFromCellRef.current = null;
              setIsJumpOpen(true);
            }}
            style={{ padding: '0.4rem 0.8rem', cursor: 'pointer', backgroundColor: '#495057', color: '#fff', border: '1px solid #6c757d', borderRadius: '4px' }}
          >
            Jump to Creature (Alt+J)
          </button>
          {effectiveMapSize.regions && effectiveMapSize.regions.length > 0 && (
            <button
              ref={regionJumpTriggerRef}
              type="button"
              onClick={() => {
                regionJumpOpenedFromCellRef.current = null;
                setIsRegionJumpOpen(true);
              }}
              style={{ padding: '0.4rem 0.8rem', cursor: 'pointer', backgroundColor: '#495057', color: '#fff', border: '1px solid #6c757d', borderRadius: '4px' }}
            >
              Jump to Region (Alt+L)
            </button>
          )}
          <button
            ref={radarTriggerRef}
            type="button"
            onClick={() => openRadarForUnit()}
            style={{ padding: '0.4rem 0.8rem', cursor: 'pointer', backgroundColor: '#0d6efd', color: '#fff', fontWeight: 'bold', border: 'none', borderRadius: '4px' }}
          >
            Radar Scan (Alt+E)
          </button>
          {dmMapUrl && playerMapUrl && (
            <button
              type="button"
              onClick={() => setMapVersion(v => v === 'dm' ? 'player' : 'dm')}
              style={{ padding: '0.4rem 0.8rem', cursor: 'pointer', backgroundColor: '#495057', color: '#fff', border: '1px solid #6c757d', borderRadius: '4px' }}
            >
              {mapVersion === 'dm' ? 'Art: DM View' : 'Art: Player View'}
            </button>
          )}
          {(dmMapUrl || playerMapUrl) && (
            <button
              type="button"
              onClick={() => setIsMapBackdropVisible(v => !v)}
              aria-pressed={isMapBackdropVisible}
              style={{ padding: '0.4rem 0.8rem', cursor: 'pointer', backgroundColor: '#343a40', color: '#fff', border: '1px solid #6c757d', borderRadius: '4px' }}
            >
              {isMapBackdropVisible ? 'Hide Grid Backdrop' : 'Show Grid Backdrop'}
            </button>
          )}
        </div>
      </div>

      {/* Current Cell Status Bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '0.75rem',
          flexWrap: 'wrap',
          gap: '0.5rem',
          backgroundColor: '#23272b',
          padding: '0.4rem 0.75rem',
          borderRadius: '4px',
          fontSize: '0.85rem'
        }}
      >
        <span style={{ color: '#adb5bd' }}>
          Navigate grid with <strong>Arrow keys</strong> (Home and End jump to the row edges; add Ctrl for map corners). Press <strong>Escape</strong> to exit board. Press <strong>Alt+B</strong> to focus board.
        </span>
        <span style={{ color: '#ffc107', marginLeft: 'auto' }}>
          Current: <strong>{coordinateToLabel(focusedCell)}</strong>{getRegionLabel(focusedCell)} {focusedOccupant ? `(${focusedOccupant.name})` : '(Empty)'}
        </span>
      </div>

      {/* Move Mode Active Banner */}
      {moveModeUnit && (
        <div
          role="status"
          style={{
            backgroundColor: '#ffc107',
            color: '#212529',
            padding: '0.75rem 1rem',
            borderRadius: '4px',
            marginBottom: '1rem',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontWeight: 'bold'
          }}
        >
          <span>
            Moving {moveModeUnit.name}: currently at {coordinateToLabel(focusedCell)}{getRegionLabel(focusedCell)} ({moveOrigin ? calculateDistance(moveOrigin, focusedCell) : 0} ft from start).
          </span>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              type="button"
              onClick={() => handleConfirmMove()}
              style={{ backgroundColor: '#198754', color: '#fff', border: 'none', padding: '0.3rem 0.8rem', borderRadius: '4px', cursor: 'pointer' }}
            >
              Confirm Move (Enter)
            </button>
            <button
              type="button"
              onClick={handleCancelMove}
              style={{ backgroundColor: '#dc3545', color: '#fff', border: 'none', padding: '0.3rem 0.8rem', borderRadius: '4px', cursor: 'pointer' }}
            >
              Cancel (Esc)
            </button>
          </div>
        </div>
      )}

      {/* Selected Cell Action Helper Bar */}
      {focusedOccupant && !moveModeUnit && (
        <div
          style={{
            backgroundColor: '#2b3035',
            padding: '0.5rem 1rem',
            borderRadius: '4px',
            marginBottom: '0.75rem',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            border: '1px solid #495057'
          }}
        >
          <div>
            <strong>{focusedOccupant.name}</strong> at {coordinateToLabel(focusedCell)}{getRegionLabel(focusedCell)} • {focusedOccupant.isPlayer ? 'Player' : 'Monster'} • {focusedOccupant.currentHp ?? '?'}/{focusedOccupant.maxHp ?? '?'} HP
            {focusedOccupant.instanceId === activeTurnUnitId && <span style={{ color: '#ffc107', marginLeft: '0.5rem' }}>★ Active Turn</span>}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              type="button"
              onClick={() => openUnitActionMenu(focusedOccupant, focusedCell)}
              style={{ padding: '0.25rem 0.6rem', fontSize: '0.85rem', cursor: 'pointer', backgroundColor: '#0d6efd', color: '#fff', fontWeight: 'bold', border: 'none', borderRadius: '4px' }}
            >
              Open Menu (Enter)
            </button>
            <button
              type="button"
              onClick={() => handleStartMoveMode(focusedOccupant)}
              style={{ padding: '0.25rem 0.6rem', fontSize: '0.85rem', cursor: 'pointer', backgroundColor: '#495057', color: '#fff', border: 'none', borderRadius: '4px' }}
            >
              Move (M)
            </button>
            {onOpenOperations && !focusedOccupant.isPlayer && (
              <button
                type="button"
                onClick={() => onOpenOperations(focusedOccupant)}
                style={{ padding: '0.25rem 0.6rem', fontSize: '0.85rem', cursor: 'pointer', backgroundColor: '#dc3545', color: '#fff', border: 'none', borderRadius: '4px' }}
              >
                Actions (A)
              </button>
            )}
            {onOpenDetails && (
              <button
                type="button"
                onClick={() => onOpenDetails(focusedOccupant)}
                style={{ padding: '0.25rem 0.6rem', fontSize: '0.85rem', cursor: 'pointer', backgroundColor: '#6c757d', color: '#fff', border: 'none', borderRadius: '4px' }}
              >
                Details (D)
              </button>
            )}
          </div>
        </div>
      )}

      {/* Tactical Combat Grid Container (role="application" signals screen readers like JAWS/NVDA to delegate arrow navigation without manual virtual cursor toggle) */}
      <div
        role={isModalActive ? undefined : "application"}
        aria-label={isModalActive ? undefined : "Combat Map Tactical Grid"}
        aria-hidden={isModalActive ? true : undefined}
        style={{ overflowX: 'auto', border: '2px solid #495057', borderRadius: '6px', backgroundColor: '#121416', position: 'relative' }}
      >
        {/* Exactly as wide as the table, so the backdrop stays under the cells whether the board is
            centred (wide viewports) or scrolls horizontally (narrow viewports). */}
        <div style={{ position: 'relative', width: 'fit-content', margin: '0 auto' }}>
          {isMapBackdropVisible && activeMapUrl && (
            <div
              aria-hidden="true"
              style={{
                position: 'absolute',
                top: `${HEADER_ROW_PX}px`,
                left: `${LABEL_COL_PX}px`,
                width: `${effectiveMapSize.width * CELL_PX}px`,
                height: `${effectiveMapSize.height * CELL_PX}px`,
                backgroundImage: `url(${activeMapUrl})`,
                backgroundSize: backdropSize,
                backgroundPosition: backdropPosition,
                backgroundRepeat: 'no-repeat',
                opacity: 0.9,
                pointerEvents: 'none',
                zIndex: 0
              }}
            />
          )}
          <table
            ref={tableRef}
            role="grid"
            aria-label="Combat Map"
            aria-rowcount={effectiveMapSize.height}
            aria-colcount={effectiveMapSize.width}
            style={{
              // An explicit width keeps the automatic layout from shrinking the cells to fit a narrow
              // viewport, and separate borders keep each column and row at exactly CELL_PX (collapsed
              // borders plus the browser's default cell padding made them a few pixels larger).
              borderCollapse: 'separate',
              borderSpacing: 0,
              tableLayout: 'fixed',
              width: `${LABEL_COL_PX + effectiveMapSize.width * CELL_PX}px`,
              position: 'relative',
              zIndex: 1,
              backgroundColor: 'transparent'
            }}
          >
            <colgroup>
              <col style={{ width: `${LABEL_COL_PX}px` }} />
              {Array.from({ length: effectiveMapSize.width }, (_, colIdx) => (
                <col key={colIdx} style={{ width: `${CELL_PX}px` }} />
              ))}
            </colgroup>
            <thead aria-hidden="true">
              <tr style={{ userSelect: 'none' }}>
                {/* Corner Empty Header */}
                <th className="combat-grid-header combat-grid-corner" />
                {Array.from({ length: effectiveMapSize.width }, (_, colIdx) => (
                  <th key={colIdx} className="combat-grid-header">
                    {columnIndexToLabel(colIdx)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody
              onClick={handleTableClick}
              onKeyDown={handleTableKeyDown}
            >
              {Array.from({ length: effectiveMapSize.height }, (_, rowIdx) => (
                <tr key={rowIdx} role="row">
                  {/* Row Number (Visual guide only, aria-hidden so screen readers don't prefix with row number) */}
                  <td aria-hidden="true" className="combat-grid-row-label">
                    {rowIdx + 1}
                  </td>

                  {/* Grid Cells (Optimized with React.memo GridCell component) */}
                  {Array.from({ length: effectiveMapSize.width }, (_, colIdx) => {
                    const pos: Position = { x: colIdx, y: rowIdx };
                    const coordLabel = coordinateToLabel(pos);
                    const regionTag = getRegionLabel(pos);
                    const isFocused = focusedCell.x === colIdx && focusedCell.y === rowIdx;
                    const occupant = unitByCoord.get(`${colIdx},${rowIdx}`);
                    const isMovingThis = moveModeUnit && occupant?.instanceId === moveModeUnit.instanceId;
                    const isActiveTurn = occupant && occupant.instanceId === activeTurnUnitId;

                    // Build Accessible Label with Region Annotation
                    let cellAriaLabel: string;
                    if (occupant) {
                      const role = occupant.isPlayer ? 'Player' : 'Monster';
                      const hp = occupant.currentHp !== undefined ? `, ${occupant.currentHp} of ${occupant.maxHp ?? '?'} HP` : '';
                      const activePrefix = isActiveTurn ? 'Active Turn, ' : '';
                      const movingPrefix = isMovingThis ? 'Moving ' : '';
                      cellAriaLabel = `${coordLabel}${regionTag}: ${activePrefix}${movingPrefix}${occupant.name} (${role})${hp}. Press Enter for menu.`;
                    } else {
                      cellAriaLabel = `${coordLabel}${regionTag}, Empty`;
                    }

                    return (
                      <GridCell
                        key={colIdx}
                        colIdx={colIdx}
                        rowIdx={rowIdx}
                        isFocused={isFocused}
                        occupant={occupant}
                        isMovingThis={Boolean(isMovingThis)}
                        isActiveTurn={Boolean(isActiveTurn)}
                        hasMapArt={Boolean(isMapBackdropVisible && activeMapUrl)}
                        cellAriaLabel={cellAriaLabel}
                        coordLabel={coordLabel}
                      />
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Unit Action Menu Modal (Opens when clicking or pressing Enter on a monster/unit) */}
      <UnitActionModal
        isOpen={isActionModalOpen}
        unit={actionModalUnit}
        position={actionModalPos}
        onClose={() => {
          setIsActionModalOpen(false);
          const cellToFocus = actionModalPos || focusedCell;
          setActionModalUnit(null);
          setActionModalPos(null);
          // Restore focus to the cell that opened the menu
          focusCell(cellToFocus, 50);
        }}
        onStartMove={unit => {
          closeActionModal();
          handleStartMoveMode(unit);
        }}
        onOpenOperations={unit => {
          const cell = actionModalPos || focusedCell;
          closeActionModal();
          onOpenOperations?.(unit, cell);
        }}
        onOpenDetails={unit => {
          const cell = actionModalPos || focusedCell;
          closeActionModal();
          onOpenDetails?.(unit, cell);
        }}
        onOpenRadar={unit => {
          const cell = actionModalPos || focusedCell;
          closeActionModal();
          openRadarForUnit(unit, true, cell);
        }}
      />

      {/* Nearby Entities Modal */}
      <NearbyEntitiesModal
        isOpen={isRadarOpen}
        originUnit={radarOriginUnit || focusedOccupant}
        originPosition={radarOriginUnit?.position || focusedCell}
        allUnits={units}
        mapSize={effectiveMapSize}
        onConfirmMoveTowards={(newPos, _movedFeet, announcement, movingUnitId) => {
          const unitIdToMove = movingUnitId || radarOriginUnit?.instanceId || focusedOccupant?.instanceId;
          if (unitIdToMove) {
            onUpdateUnitPosition(unitIdToMove, newPos);
          }
          setIsRadarOpen(false);
          setRadarOriginUnit(null);
          radarOpenedFromCellRef.current = false;
          radarReturnCellRef.current = null;
          const clampedX = Math.max(0, Math.min(effectiveMapSize.width - 1, newPos.x));
          const clampedY = Math.max(0, Math.min(effectiveMapSize.height - 1, newPos.y));
          setFocusedCell({ x: clampedX, y: clampedY });
          setLiveAnnouncement(announcement);

          // Return focus to the map point where creature moved
          focusCell(newPos, 50);
        }}
        onClose={() => {
          setIsRadarOpen(false);
          const returnCell = radarOpenedFromCellRef.current ? radarReturnCellRef.current : null;
          setRadarOriginUnit(null);
          radarOpenedFromCellRef.current = false;
          radarReturnCellRef.current = null;

          if (returnCell) {
            focusCell(returnCell, 50);
          } else {
            // Restore focus to radar trigger button
            setTimeout(() => radarTriggerRef.current?.focus(), 50);
          }
        }}
      />

      {/* Creature Jump Modal */}
      <CreatureJumpModal
        isOpen={isJumpOpen}
        units={units}
        regions={effectiveMapSize.regions}
        onSelect={targetPos => {
          setIsJumpOpen(false);
          moveFocusTo(targetPos);
          const regionTag = getRegionLabel(targetPos);
          setLiveAnnouncement(`Jumped map focus to ${coordinateToLabel(targetPos)}${regionTag}.`);
        }}
        onClose={() => {
          setIsJumpOpen(false);
          if (jumpOpenedFromCellRef.current) {
            const returnCell = jumpOpenedFromCellRef.current;
            jumpOpenedFromCellRef.current = null;
            focusCell(returnCell, 50);
          } else {
            // Restore focus to jump trigger button
            setTimeout(() => jumpTriggerRef.current?.focus(), 0);
          }
        }}
      />

      {/* Region Jump Modal */}
      <RegionJumpModal
        isOpen={isRegionJumpOpen}
        regions={effectiveMapSize.regions || []}
        mapSize={effectiveMapSize}
        onSelect={(targetPos, region) => {
          setIsRegionJumpOpen(false);
          moveFocusTo(targetPos);
          const idTag = region.id && region.id !== 'ocean' ? ` (${region.id})` : '';
          setLiveAnnouncement(`Teleported map focus to ${region.name}${idTag} at cell ${coordinateToLabel(targetPos)}.`);
        }}
        onClose={() => {
          setIsRegionJumpOpen(false);
          if (regionJumpOpenedFromCellRef.current) {
            const returnCell = regionJumpOpenedFromCellRef.current;
            regionJumpOpenedFromCellRef.current = null;
            focusCell(returnCell, 50);
          } else {
            // Restore focus to region jump trigger button
            setTimeout(() => regionJumpTriggerRef.current?.focus(), 0);
          }
        }}
      />
    </section>
  );
}
